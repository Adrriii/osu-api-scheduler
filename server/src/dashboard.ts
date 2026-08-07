import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import {
  authMode,
  beginLogin,
  completeOauth,
  cookieHeader,
  handoffEnabled,
  isAuthed,
  issueSession,
  passwordValid,
  PASSWORD_SUBJECT,
  verifyAssertion,
} from './auth.js';
import { config } from './config.js';
import { log } from './log.js';
import type { Scheduler } from './scheduler.js';
import { store } from './store.js';

/** Windows the dashboard offers, and the bucket size each is drawn at. */
/**
 * Bucket sizes decide which stored resolution answers the query: under an hour
 * comes from memory, an hour or more from the hourly rows, a day or more from
 * the daily ones. So `day` buckets at an hour rather than half an hour.
 */
const RANGES = {
  hour: { sinceMs: 3_600_000, bucketMs: 60_000 },
  day: { sinceMs: 86_400_000, bucketMs: 3_600_000 },
  month: { sinceMs: 30 * 86_400_000, bucketMs: 86_400_000 },
  year: { sinceMs: 365 * 86_400_000, bucketMs: 7 * 86_400_000 },
} as const;

type RangeKey = keyof typeof RANGES;
const isRange = (v: string): v is RangeKey => Object.hasOwn(RANGES, v);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function mountDashboard(app: Hono, scheduler: Scheduler): void {
  // ---- auth ---------------------------------------------------------------

  /** Minimal server-rendered form: the app bundle itself is behind the gate. */
  const passwordForm = (error?: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <meta name="color-scheme" content="light dark"><title>osu! API scheduler</title>
     <link rel="icon" href="/favicon.svg" type="image/svg+xml">
     <style>
       /* Dark only, matching the dashboard behind it. Text inputs are
          content-box by default, so width:100% plus padding and border spills
          past the form; buttons are border-box already, which is why only the
          input overflowed. */
       *{box-sizing:border-box}
       body{margin:0;min-height:100vh;display:grid;place-items:center;background:#16151a;color:#fff;
            font:14px/1.5 ui-rounded,"Nunito","Varela Round",system-ui,-apple-system,"Segoe UI",sans-serif}
       form{background:#242229;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:24px;
            min-width:320px;overflow:hidden}
       /* The same gradient the dashboard banner uses, so the two read as one product. */
       h1{font-size:16px;margin:-24px -24px 18px;font-weight:800;padding:14px 20px;color:#fff;
          background:linear-gradient(100deg,#5b1d9e 0%,#8f2a94 45%,#c2266f 100%)}
       input{font:inherit;width:100%;padding:9px 11px;border-radius:9px;border:1px solid rgba(255,255,255,.12);
             background:#16151a;color:#fff;margin-bottom:12px}
       input:focus{outline:2px solid #ff66ab;outline-offset:1px;border-color:transparent}
       button{font:inherit;width:100%;padding:9px;border-radius:9px;border:0;background:#ff66ab;color:#2a0a1a;
              font-weight:800;cursor:pointer}
       button:hover{background:#ff7db7}
       .err{color:#ef4444;font-size:13px;margin:0 0 12px;font-weight:600}
     </style></head><body>
     <form method="post" action="/auth/password">
       <h1>osu! API scheduler</h1>
       ${error ? `<p class="err">${error}</p>` : ''}
       <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
       <button type="submit">Sign in</button>
     </form></body></html>`;

  app.get('/auth/login', (c) => {
    const mode = authMode();
    if (mode === 'none') return c.redirect('/');
    if (mode === 'password') return c.html(passwordForm());

    const started = beginLogin();
    if ('error' in started) return c.text(started.error, 503);
    return c.redirect(started.url);
  });

  app.post('/auth/password', async (c) => {
    if (authMode() !== 'password') return c.text('Password sign-in is not enabled.', 404);
    const body = await c.req.parseBody();
    const supplied = typeof body.password === 'string' ? body.password : '';
    if (!passwordValid(supplied)) {
      log.warn('dashboard password rejected');
      // Deliberately vague and deliberately not timing-revealing (the compare
      // is constant time); there is one password and no user to enumerate.
      return c.html(passwordForm('Incorrect password.'), 403);
    }
    log.info('dashboard sign-in', { via: 'password' });
    return signIn(PASSWORD_SUBJECT);
  });

  const signIn = (uid: number) =>
    new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': cookieHeader(issueSession(uid), Math.floor(config.sessionTtlMs / 1000)),
      },
    });

  /** Standard OAuth callback. */
  app.get('/auth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state') ?? '';
    if (!code) return c.text('Sign-in refused: no code provided.', 400);

    const result = await completeOauth(code, state);
    if (!result.ok) {
      log.warn('dashboard sign-in refused', { why: result.why });
      return c.text(`Sign-in refused: ${result.why}`, 403);
    }
    log.info('dashboard sign-in', { uid: result.uid });
    return signIn(result.uid);
  });

  /** Handoff mode: another site vouched for the user. */
  app.get('/auth/accept', (c) => {
    if (!handoffEnabled()) return c.text('Handoff sign-in is not enabled.', 404);
    const q = c.req.query();
    const result = verifyAssertion({
      uid: Number(q.uid),
      nonce: String(q.nonce ?? ''),
      exp: Number(q.exp),
      sig: String(q.sig ?? ''),
    });
    if (!result.ok) {
      log.warn('dashboard sign-in refused', { why: result.why, uid: q.uid });
      return c.text(`Sign-in refused: ${result.why}`, 403);
    }
    log.info('dashboard sign-in', { uid: result.uid, via: 'handoff' });
    return signIn(result.uid);
  });

  app.get('/auth/logout', () =>
    new Response(null, {
      status: 302,
      headers: { Location: '/', 'Set-Cookie': cookieHeader('', 0) },
    }),
  );

  // ---- data ---------------------------------------------------------------

  const authed = (c: Context): boolean => isAuthed(c.req.header('cookie'));
  const guard = (c: Context) => (authed(c) ? null : c.json({ error: 'not signed in' }, 401));

  app.get('/dash/summary', (c) => {
    const denied = guard(c);
    if (denied) return denied;

    const rangeRaw = c.req.query('range') ?? 'hour';
    const range = isRange(rangeRaw) ? rangeRaw : 'hour';
    const { sinceMs, bucketMs } = RANGES[range];
    const since = Date.now() - sinceMs;

    return c.json({
      range,
      bucketMs,
      now: Date.now(),
      sourceUrl: config.sourceUrl,
      version: config.version,
      homeUrl: config.homeUrl,
      homeLabel: config.homeLabel,
      live: scheduler.snapshot(),
      ...store.summary(since),
      latency: store.latencyByTier(),
      series: store.series(since, bucketMs),
      seriesByConsumer: store.seriesByConsumer(since, bucketMs),
      // Every window at once, so the header counters do not need three round
      // trips or go stale against the chart below them.
      windows: {
        hour: store.summary(Date.now() - RANGES.hour.sinceMs).totals,
        day: store.summary(Date.now() - RANGES.day.sinceMs).totals,
        month: store.summary(Date.now() - RANGES.month.sinceMs).totals,
      },
    });
  });

  app.get('/dash/recent', (c) => {
    const denied = guard(c);
    if (denied) return denied;
    return c.json({ recent: store.recent(150) });
  });

  /** Server-sent events: one line per completed request, as it happens. */
  app.get('/dash/live', (c) => {
    const denied = guard(c);
    if (denied) return denied;

    let unwatch = () => {};
    let beat: NodeJS.Timeout | null = null;
    const stop = () => {
      unwatch();
      if (beat) clearInterval(beat);
      beat = null;
    };

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            // Client vanished mid-write. Tear down now rather than waiting for
            // cancel(), which does not always fire on an abrupt disconnect --
            // otherwise the ticker outlives every closed tab.
            stop();
          }
        };

        send('hello', { ok: true });
        unwatch = scheduler.watch((rec) => send('request', rec));
        // Keeps the connection warm through proxies that cut idle streams, and
        // doubles as the bucket/queue ticker the page reads.
        beat = setInterval(() => send('stats', scheduler.snapshot()), 2000);
      },
      cancel: stop,
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Apache and nginx both buffer proxied responses by default, which
        // would hold the feed back until the buffer filled.
        'x-accel-buffering': 'no',
      },
    });
  });

  // ---- static dashboard ---------------------------------------------------

  const serve = (c: Context, relPath: string) => {
    // normalize + prefix check: the path comes from the URL, so it must not be
    // able to climb out of the build directory.
    const full = normalize(join(config.webRoot, relPath));
    if (!full.startsWith(normalize(config.webRoot))) return c.text('Not found', 404);
    if (!existsSync(full) || !statSync(full).isFile()) return null;

    const body = Readable.toWeb(createReadStream(full)) as ReadableStream;
    const isHashed = /-[A-Za-z0-9_]{8,}\./.test(relPath);
    return new Response(body, {
      headers: {
        'content-type': MIME[extname(full)] ?? 'application/octet-stream',
        // Vite fingerprints assets, so those can be cached hard; index.html
        // must not be, or a deploy is invisible until someone force-reloads.
        'cache-control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    });
  };

  app.get('/assets/*', (c) => serve(c, c.req.path) ?? c.text('Not found', 404));

  // Before the sign-in gate: the login page needs it too, and an icon is not
  // worth authenticating.
  app.get('/favicon.svg', (c) => serve(c, '/favicon.svg') ?? c.text('Not found', 404));

  app.get('*', (c) => {
    // Everything else is the single page app, behind sign-in.
    if (!authed(c)) return c.redirect('/auth/login');
    const asset = serve(c, c.req.path);
    if (asset) return asset;
    const index = serve(c, '/index.html');
    if (index) return index;
    return c.text(
      'Dashboard build missing. Run `npm run build`, or set SCHEDULER_WEB_ROOT.',
      500,
    );
  });
}
