import { createAdaptorServer, serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { DEFAULT_TIER, config, isTier, TIERS } from './config.js';
import { log } from './log.js';
import type { JobRequest } from './queue.js';
import { Scheduler } from './scheduler.js';
import { mountDashboard } from './dashboard.js';
import { schedulerTokenValid } from './auth.js';
import { store } from './store.js';

const scheduler = new Scheduler();
const app = new Hono();

let refusedSinceReport = 0;
let lastRefusalReport = 0;

/**
 * Headers we must not forward upstream: hop-by-hop ones, whatever the caller
 * guessed for auth (the broker owns the token), and anything describing the
 * caller's own connection.
 */
const STRIPPED = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'x-osu-priority',
  'x-osu-max-wait-ms',
  'x-scheduler-token',
]);

function tierOf(raw: string | undefined): { tier: typeof DEFAULT_TIER; unknown: string | null } {
  if (!raw) return { tier: DEFAULT_TIER, unknown: null };
  const v = raw.trim();
  if (isTier(v)) return { tier: v, unknown: null };
  // An unrecognised tier is a caller bug. Serving it at the lowest priority is
  // safer than guessing high and letting a typo outrank the collector.
  return { tier: DEFAULT_TIER, unknown: v };
}

async function proxy(c: Context) {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/+/, '');

  // Header is the normal way to declare a tier, but some callers cannot set
  // one -- osu!daily's parallel fetcher takes a bare URL and nothing else. For
  // those, `_osu_priority` in the query does the same job; it is stripped here
  // so it never reaches osu!.
  const paramTier = url.searchParams.get('_osu_priority') ?? undefined;
  url.searchParams.delete('_osu_priority');
  // Ours, not osu!'s -- strip it before the request goes anywhere.
  url.searchParams.delete('_scheduler_token');

  const { tier, unknown } = tierOf(c.req.header('x-osu-priority') ?? paramTier);
  if (unknown) log.warn('unknown priority tier, using default', { got: unknown, path });

  // X-Osu-Max-Wait-Ms: 0 (or "never") means exactly that -- queue it until it
  // is served, however long the backoff lasts. Some callers would rather wait
  // an hour than be told to give up: a score the collector never fetches is
  // gone, whereas a late one is merely late.
  const rawMaxWait = (c.req.header('x-osu-max-wait-ms') ?? '').trim().toLowerCase();
  const parsedMaxWait = Number.parseInt(rawMaxWait, 10);
  const maxWaitMs =
    rawMaxWait === 'never' || parsedMaxWait === 0
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(parsedMaxWait) && parsedMaxWait > 0
        ? parsedMaxWait
        : config.defaultMaxWaitMs;

  if (scheduler.queue.isFull) {
    return c.json(
      { error: 'broker queue full', queued: scheduler.queue.size },
      503,
      { 'x-scheduler-error': 'queue-full' },
    );
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.header())) {
    if (!STRIPPED.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
  }

  const method = c.req.method;
  const body = method === 'GET' || method === 'HEAD' ? null : await c.req.text();

  const request: JobRequest = {
    method,
    path,
    query: url.searchParams.toString(),
    body,
    headers,
  };

  // Identity is whatever the caller put in its User-Agent. Every consumer on
  // this host sets one; anything that does not shows up as "unknown" on the
  // dashboard, which is the point -- unattributable traffic should be visible.
  const consumer = (c.req.header('user-agent') ?? '').split(' ')[0] || 'unknown';

  const result = await scheduler.submit(tier, consumer, request, maxWaitMs);

  if (!result.ok) {
    const status = result.reason === 'timeout' ? 504 : 503;
    return c.json(
      { error: `broker ${result.reason}`, waitedMs: result.waitedMs, tier },
      status,
      { 'x-scheduler-error': result.reason, 'x-scheduler-waited-ms': String(result.waitedMs) },
    );
  }

  const out = new Headers();
  const contentType = result.headers['content-type'];
  if (contentType) out.set('content-type', contentType);
  // Pass osu!'s own backoff hint through so callers can log it, even though
  // the broker has already acted on it for everyone.
  const retryAfter = result.headers['retry-after'];
  if (retryAfter) out.set('retry-after', retryAfter);
  out.set('x-scheduler-waited-ms', String(result.waitedMs));
  out.set('x-scheduler-tier', tier);
  // The one header that says "osu! actually answered this". Every other
  // response from here -- a bad token, a full queue, a timeout, a transport
  // failure -- is the scheduler talking about itself, and a client must be able
  // to tell the difference without guessing from the status code. Inferring it
  // from the status is what let a 401 for a wrong scheduler token read as osu!
  // saying a player did not exist.
  out.set('x-scheduler-upstream', '1');

  return new Response(result.body, { status: result.status, headers: out });
}

// Everything under /api is proxied verbatim -- v2 with the caller's bearer,
// v1 with the caller's ?k= key. Both cost the same per-IP budget.
//
// Using the broker at all requires the shared broker password. That is a
// different thing from the osu! credentials in the forwarded Authorization
// header: this one guards the *budget*, which is the thing worth stealing.
// ~1200 requests from anyone locks every project on this host out of the osu!
// API for 30 minutes, and no osu! token of ours is needed to do it. With the
// password in front, the proxy is safe to reach from outside.
app.all('/api/*', (c) => {
  const url = new URL(c.req.url);
  const presented =
    c.req.header('x-scheduler-token') ?? url.searchParams.get('_scheduler_token') ?? undefined;

  if (!schedulerTokenValid(presented)) {
    // Summarise rather than log per request: a consumer running pre-token code
    // retries in a loop, and a line each would bury everything else.
    refusedSinceReport++;
    const now = Date.now();
    if (now - lastRefusalReport > 30_000) {
      log.warn('refusing proxy requests without a valid broker token', {
        count: refusedSinceReport,
        since: `${Math.round((now - lastRefusalReport) / 1000)}s`,
        lastPath: c.req.path,
      });
      lastRefusalReport = now;
      refusedSinceReport = 0;
    }
    return c.json({ error: 'a valid scheduler token is required' }, 401, {
      'x-scheduler-error': 'bad-token',
    });
  }
  return proxy(c);
});

app.get('/stats', (c) => c.json(scheduler.snapshot()));
app.get('/healthz', (c) => c.json({ ok: true, tiers: TIERS }));

// Last: it owns the catch-all that serves the dashboard.
mountDashboard(app, scheduler);

function announce(addr: string) {
  log.info('osu! API scheduler listening', {
    addr,
    sustainedPerMin: scheduler.snapshot().sustainedPerMin,
    tiers: Object.keys(TIERS).join(','),
  });
}

/**
 * systemd passes an already-listening socket as fd 3 when the matching .socket
 * unit is in use. LISTEN_PID guards against inheriting one meant for a
 * different process.
 *
 * Using it instead of binding our own port is what makes a restart invisible:
 * systemd holds the socket open across it, so callers still connect and their
 * requests wait in the kernel backlog rather than being refused. The new
 * process accepts them as soon as it is up. Without this the same restart is a
 * few seconds of connection errors at every consumer.
 */
const SD_LISTEN_FD = 3;
const socketActivated =
  Number(process.env.LISTEN_FDS ?? 0) > 0 && Number(process.env.LISTEN_PID ?? 0) === process.pid;

const server = socketActivated
  ? createAdaptorServer({ fetch: app.fetch })
  : serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) =>
      announce(`${config.host}:${info.port}`),
    );

if (socketActivated) {
  server.listen({ fd: SD_LISTEN_FD }, () => announce(`systemd socket (fd ${SD_LISTEN_FD})`));
}

// Cheap enough to do often, and the buckets are what a restart most visibly
// loses.
setInterval(() => scheduler.saveState(), 30_000).unref();

async function shutdown(signal: string) {
  const queued = scheduler.queue.size;
  log.info('draining before shutdown', { signal, queued, graceMs: config.shutdownGraceMs });
  // Close the listener first so nothing new arrives. Connections already open
  // stay up, which is what lets the queued jobs still answer their callers.
  server.close();
  await scheduler.stop(config.shutdownGraceMs);
  // Last, so what is written is what was true at the end of the drain.
  scheduler.saveState();
  store.saveMemory();
  log.info('shutdown complete', { served: queued - scheduler.queue.size });
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
