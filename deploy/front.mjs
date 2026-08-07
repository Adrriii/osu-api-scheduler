/**
 * Holds the published port so restarts are not felt.
 *
 * On bare metal systemd owns the listening socket and the kernel queues
 * connections while the service is replaced. A container has no equivalent: the
 * socket belongs to the container, and updating destroys and recreates it, so
 * every update is a few seconds of refused connections.
 *
 * This is that missing piece. It binds the port and never goes down, so a
 * caller's connection is always accepted. Only then does it dial the scheduler,
 * and if that is mid-restart it keeps trying while the caller waits. The caller
 * sees latency instead of a failure, which is the same trade the kernel backlog
 * makes.
 *
 * No off-the-shelf proxy does this. Apache, nginx and HAProxy all answer 502 the
 * moment a connect is refused, and their retry settings only control how quickly
 * they try again, not whether they wait. Retrying instantly against a socket
 * that is not listening exhausts the retries in microseconds.
 *
 * Deliberately TCP and not HTTP: it never parses a request, so it cannot
 * mishandle one, and streaming responses pass through untouched. The scheduler
 * authenticates by token rather than by address, so losing the caller's IP at
 * this hop costs nothing.
 */
import { createServer, connect } from 'node:net';

const PORT = Number(process.env.FRONT_PORT ?? 7654);
const HOST = process.env.FRONT_HOST ?? '0.0.0.0';
const TARGET_HOST = process.env.FRONT_TARGET_HOST ?? 'scheduler';
const TARGET_PORT = Number(process.env.FRONT_TARGET_PORT ?? 7654);
/** How long a caller is held while the scheduler is away. */
const HOLD_MS = Number(process.env.FRONT_HOLD_MS ?? 30_000);
const RETRY_MS = Number(process.env.FRONT_RETRY_MS ?? 200);

const log = (msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

let held = 0;

function dial(client) {
  const deadline = Date.now() + HOLD_MS;
  let waited = false;
  let upstream = null;

  // Registered once. Inside the retry it stacked a listener per attempt, which
  // a long hold turns into hundreds.
  client.once('close', () => upstream?.destroy());

  const attempt = () => {
    if (client.destroyed) return;

    upstream = connect(TARGET_PORT, TARGET_HOST);

    const sock = upstream;
    sock.once('connect', () => {
      if (waited) {
        held--;
        log('held connection handed over', { waitedMs: HOLD_MS - (deadline - Date.now()) });
      }
      client.pipe(sock);
      sock.pipe(client);
    });

    sock.once('error', (err) => {
      sock.destroy();
      // Every connect failure is retried until the deadline, with no attempt to
      // judge which ones are worth waiting on. Judging them was wrong: a stopped
      // container loses its DNS entry, so the failure is EAI_AGAIN rather than
      // ECONNREFUSED, and treating that as fatal gave up instantly on exactly
      // the case this exists for. There is no connect error that means "it will
      // never come back", only the deadline.
      if (Date.now() >= deadline) {
        if (waited) held--;
        // A caller speaking HTTP gets an answer it can read rather than a
        // dropped socket it can only guess at.
        client.end(
          'HTTP/1.1 503 Service Unavailable\r\n'
          + 'Content-Length: 0\r\n'
          + 'X-Scheduler-Error: front-no-upstream\r\n'
          + 'Connection: close\r\n\r\n',
        );
        log('gave up on upstream', { code: err.code });
        return;
      }

      if (!waited) {
        waited = true;
        held++;
        log('scheduler not answering, holding caller', { code: err.code, held });
      }
      setTimeout(attempt, RETRY_MS);
    });
  };

  attempt();
}

const server = createServer((client) => {
  client.on('error', () => client.destroy());
  dial(client);
});

server.listen(PORT, HOST, () => {
  log('front listening', { on: `${HOST}:${PORT}`, forwardsTo: `${TARGET_HOST}:${TARGET_PORT}`, holdMs: HOLD_MS });
});

// Nothing here is worth losing the socket over.
process.on('uncaughtException', (err) => log('front error', { err: String(err) }));
