import { readFileSync } from 'node:fs';

/** Version from package.json, so the footer cannot drift from the release. */
function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Priority levels, lowest number served first.
 *
 * Deliberately generic: the scheduler does not know or care who is calling. A
 * caller states how much delay its own work can absorb and the scheduler
 * schedules on that alone. Naming levels after consumers would mean editing
 * shared infrastructure every time a project was added, and would encode one
 * project's opinion of its own importance into everyone else's queue.
 *
 * Pick by what a delay costs, not by how much you care about the job:
 *   realtime    - a missed window cannot be recovered (score collection)
 *   interactive - a person is waiting on the response (logins, page loads)
 *   high        - background, but something visible is stale until it lands
 *   normal      - routine background work, including sweeps
 */
export const TIERS = {
  realtime: 0,
  interactive: 10,
  high: 20,
  normal: 30,
} as const;

export type Tier = keyof typeof TIERS;
/** Unstated priority is treated as the least urgent thing on the host. */
export const DEFAULT_TIER: Tier = 'normal';

export function isTier(v: string): v is Tier {
  return Object.hasOwn(TIERS, v);
}

const str = (k: string, fallback: string) => process.env[k] ?? fallback;
const num = (k: string, fallback: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : fallback;
};

/** State that must survive a restart but is not worth a database. */
const STATE_DIR = str('SCHEDULER_STATE_DIR', './state');
/** Volatile cross-process state. tmpfs where there is one; the state dir otherwise. */
const RUNTIME_DIR = str('SCHEDULER_RUNTIME_DIR', STATE_DIR);

/**
 * The sustained rate, host-wide, expressed as the gap between two sends. This
 * is the *refill* rate of the token bucket, not a hard spacing: a queue that
 * has been quiet may spend what it banked and go faster for a while.
 *
 * Read from disk on every send so the ceiling can be retuned live -- restarting
 * to try a value would drop the queue. Falls back to the env value, then 1.0s.
 */
const PACE_FILE = str('SCHEDULER_PACE_FILE', `${STATE_DIR}/pace_interval`);
const PACE_FALLBACK_S = num('SCHEDULER_PACE_SECONDS', 1.0);

let lastPace = PACE_FALLBACK_S;
let lastPaceRead = 0;

export function paceIntervalMs(): number {
  const now = Date.now();
  // Re-reading a tiny file once a second is free; doing it per request when we
  // send ~1/s is not worth the syscall.
  if (now - lastPaceRead > 1000) {
    lastPaceRead = now;
    try {
      const v = Number.parseFloat(readFileSync(PACE_FILE, 'utf8').trim());
      if (Number.isFinite(v) && v > 0) lastPace = v;
    } catch {
      // Missing or unreadable: keep whatever we last had.
    }
  }
  return lastPace * 1000;
}

export const config = {
  port: num('SCHEDULER_PORT', 7654),
  host: str('SCHEDULER_HOST', '127.0.0.1'),

  upstreamBase: str('SCHEDULER_UPSTREAM', 'https://osu.ppy.sh'),

  stateDir: STATE_DIR,
  paceFile: PACE_FILE,

  /**
   * Sent on every upstream request that does not carry its own. Identifiable
   * and contactable on purpose: it is the difference between traffic osu! can
   * attribute and traffic Cloudflare treats as a bot to be challenged.
   */
  userAgent: str(
    'SCHEDULER_USER_AGENT',
    'osu-api-scheduler/1.0 (+https://github.com/Adrriii/osu-api-scheduler)',
  ),

  /**
   * Two different tokens are in play; do not conflate them.
   *
   *  - The *osu!* token belongs to each calling app. Every project has its own
   *    osu! OAuth application and passes its own Authorization header, which is
   *    forwarded untouched. The scheduler never holds or substitutes one.
   *  - This one is the scheduler's own password: a single shared secret every
   *    consumer must present to be allowed to use it at all. It is what
   *    protects the budget, and it is why the proxy can safely be exposed.
   */
  tokenFile: str('SCHEDULER_TOKEN_FILE', `${STATE_DIR}/token`),
  token: str('SCHEDULER_TOKEN', ''),

  /**
   * Burst allowance, in requests.
   *
   * osu! documents an average of 60 req/min with bursts to 1200, and measured
   * behaviour matches a token bucket of exactly that shape: across 14
   * consecutive lockouts the limiter tripped at ~1,150-1,200 requests every
   * time, which is a full bucket being spent and then overdrawn.
   *
   * Starts empty on purpose. The upstream bucket's true level is not visible,
   * so assuming a full one after a restart would be a 1200-request gamble.
   */
  burstCapacity: num('SCHEDULER_BURST_CAPACITY', 1200),

  /**
   * Global tokens only the latency-critical levels may borrow against.
   *
   * Per-level headroom is worthless without this. Nothing sends unless the
   * global bucket has a token, and sweeps always have a backlog, so they
   * borrowed every spare token and held the global bucket at zero. A burst you
   * cannot spend is not a burst. Gates borrowing only -- a level's own bank is
   * always spendable, or it deadlocks holding budget it may not use.
   */
  globalReserve: num('SCHEDULER_GLOBAL_RESERVE', 400),

  /**
   * Ceiling on the instantaneous rate while bursting (requests/min). Spending
   * the bucket is allowed; spending it all in three seconds is not.
   */
  burstMaxPerMin: num('SCHEDULER_BURST_MAX_PER_MIN', 1200),

  /**
   * Each level's share of the sustained rate. Shares divide the ceiling rather
   * than adding to it, so they should sum to 1.
   */
  tierShareOfSustained: {
    realtime: num('SCHEDULER_SHARE_REALTIME', 0.15),
    interactive: num('SCHEDULER_SHARE_INTERACTIVE', 0.15),
    high: num('SCHEDULER_SHARE_HIGH', 0.2),
    normal: num('SCHEDULER_SHARE_NORMAL', 0.5),
  } as Record<string, number>,

  /**
   * Burst capacity per level, in requests -- deliberately *not* derived from
   * the share, because the two answer different questions.
   *
   * Share is the sustained average. Capacity is how much a level may bank while
   * idle and spend in a hurry. The fast levels want the opposite of the sweeps:
   * they draw only a few requests a minute but need to go hard when they do, so
   * small shares and large headroom. Sweeps are hammered continuously, so their
   * buckets never sit full and headroom would be wasted on them.
   */
  tierBurst: {
    realtime: num('SCHEDULER_BURST_REALTIME', 400),
    interactive: num('SCHEDULER_BURST_INTERACTIVE', 300),
    high: num('SCHEDULER_BURST_HIGH', 200),
    normal: num('SCHEDULER_BURST_NORMAL', 200),
  } as Record<string, number>,

  /** Levels at or below this may borrow against the global reserve. */
  burstFreeMaxPriority: num('SCHEDULER_BURST_FREE_MAX_PRIORITY', 20),

  /**
   * Sends started concurrently. Pacing decides how often a send *starts*; this
   * decides how many may be in flight, so one slow upstream response cannot
   * drag the achieved rate below the configured ceiling.
   */
  maxInFlight: num('SCHEDULER_MAX_IN_FLIGHT', 8),

  /** Reject rather than accumulate: a queue nobody drains is just a slow 504. */
  maxQueue: num('SCHEDULER_MAX_QUEUE', 5000),

  /** Default ceiling on how long a caller will be left hanging. */
  defaultMaxWaitMs: num('SCHEDULER_DEFAULT_MAX_WAIT_MS', 300_000),

  /**
   * Anti-starvation. A job's effective priority improves by one step for every
   * `agingStepMs` waited, so a saturated top level cannot pin the bottom one at
   * zero throughput forever.
   */
  agingStepMs: num('SCHEDULER_AGING_STEP_MS', 60_000),
  agingStep: 10,

  requestTimeoutMs: num('SCHEDULER_REQUEST_TIMEOUT_MS', 30_000),

  /** Fallback pause when a limiter refuses us without saying for how long. */
  fallbackBackoffS: num('SCHEDULER_FALLBACK_BACKOFF_S', 60),

  /**
   * Pause after a bot challenge. Separate from the plain fallback because it
   * means something different -- not a quota, so no amount of waiting earns
   * capacity back -- but tuned the same, because observed challenges cleared on
   * the next attempt and a longer stall costs every level for nothing.
   */
  challengeBackoffS: num('SCHEDULER_CHALLENGE_BACKOFF_S', 60),

  /** Challenges within a minute before treating it as a real block. */
  challengeStormThreshold: num('SCHEDULER_CHALLENGE_STORM', 8),

  /** Backoff shared with anything not yet routed through the scheduler. */
  banMirrorFile: str('SCHEDULER_BAN_FILE', `${RUNTIME_DIR}/backoff_until`),

  dbPath: str('SCHEDULER_DB_PATH', `${STATE_DIR}/metrics.db`),

  /**
   * What only lives in memory while running -- the live feed, the per-minute
   * shape of the last few hours, the latency samples, and the token buckets --
   * written here on the way down and read back on the way up. Without it every
   * restart resets the buckets to empty and blanks the hour view.
   */
  memoryFile: str('SCHEDULER_MEMORY_FILE', `${STATE_DIR}/memory.json`),

  /**
   * Live detail is held in memory and never written per request; only hourly
   * and daily aggregates reach disk. A per-request row costs 111 bytes with its
   * indexes, so 60 req/min for 45 days would be 413 MB. Aggregates are ~70
   * bytes: 90 days hourly plus a decade daily is about 6 MB.
   */
  feedSize: num('SCHEDULER_FEED_SIZE', 500),
  /**
   * How long a restart may spend serving the queue it already holds before
   * giving up on the rest. Keep it below the service manager's stop timeout,
   * or the process is killed mid-drain and the point is lost.
   */
  shutdownGraceMs: num('SCHEDULER_SHUTDOWN_GRACE_MS', 25_000),

  liveMinutes: num('SCHEDULER_LIVE_MINUTES', 180),
  latencySamples: num('SCHEDULER_LATENCY_SAMPLES', 2000),

  /** Hourly rows: the detail tier behind the day and month views. */
  hourlyRetentionDays: num('SCHEDULER_HOURLY_RETENTION_DAYS', 90),
  /** Daily rows: cheap enough to keep the usage panel going back years. */
  retentionDays: num('SCHEDULER_RETENTION_DAYS', 3650),

  // ---- dashboard ---------------------------------------------------------

  /** Public origin, used to build the OAuth redirect. */
  dashboardOrigin: str('DASHBOARD_ORIGIN', 'http://localhost:7654'),

  /**
   * How the dashboard decides who may look at it.
   *
   *   oauth    - osu! OAuth, restricted to DASHBOARD_ALLOWED_OSU_IDS
   *   password - one shared password, DASHBOARD_PASSWORD
   *   none     - no check in the app; your reverse proxy is doing it
   *              (htaccess, basic auth, mTLS, a VPN, whatever)
   *
   * Unset means: infer from what is configured, and fall back to `none` with a
   * loud warning rather than silently locking you out of your own dashboard.
   */
  dashboardAuth: str('DASHBOARD_AUTH', ''),
  dashboardPassword: str('DASHBOARD_PASSWORD', ''),

  /**
   * osu! OAuth application for dashboard sign-in. Register one at
   * https://osu.ppy.sh/home/account/edit with the callback set to
   * <DASHBOARD_ORIGIN>/auth/callback. This is only for identifying the person
   * looking at the dashboard; it is never used for proxied traffic.
   */
  oauthClientId: str('DASHBOARD_OSU_CLIENT_ID', ''),
  oauthClientSecret: str('DASHBOARD_OSU_CLIENT_SECRET', ''),

  /** osu! user ids allowed in. Empty means nobody, which fails closed. */
  dashboardAllowedIds: str('DASHBOARD_ALLOWED_OSU_IDS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite),

  /** Signs session cookies. Generated into the state dir when absent. */
  sessionSecretFile: str('DASHBOARD_SESSION_SECRET_FILE', `${STATE_DIR}/session_secret`),
  sessionTtlMs: num('DASHBOARD_SESSION_TTL_MS', 30 * 86_400_000),

  /**
   * Optional: delegate sign-in to an existing osu! OAuth callback you already
   * run, instead of registering a new application. That page must hand back to
   * <origin>/auth/accept with uid/nonce/exp and an HMAC over "uid:nonce:exp"
   * keyed on the shared secret below. Useful when your osu! app's single
   * callback URL is already spoken for.
   */
  handoffSecretFile: str('DASHBOARD_HANDOFF_SECRET_FILE', ''),
  handoffAuthorizeUrl: str('DASHBOARD_HANDOFF_AUTHORIZE_URL', ''),

  /**
   * Where the source for *this* copy can be obtained.
   *
   * The AGPL requires that people interacting with the software over a network
   * be offered its source. The dashboard links here, so if you run a modified
   * copy, point this at your fork.
   */
  sourceUrl: str('SCHEDULER_SOURCE_URL', 'https://github.com/Adrriii/osu-api-scheduler'),

  version: packageVersion(),

  /** Shown in the footer. Point it at whoever runs this instance. */
  homeUrl: str('SCHEDULER_HOME_URL', 'https://rhythmgamers.net/'),
  homeLabel: str('SCHEDULER_HOME_LABEL', 'rhythmgamers.net'),

  /** Static dashboard build served at /. */
  webRoot: str('SCHEDULER_WEB_ROOT', new URL('../../web/dist', import.meta.url).pathname),
} as const;
