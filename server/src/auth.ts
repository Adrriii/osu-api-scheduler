import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

// ---------------------------------------------------------------------------
// The scheduler's own password: what a consumer must present to use the proxy
// at all. Nothing to do with the osu! tokens in forwarded Authorization
// headers -- this one guards the request budget, which is the part worth
// stealing. Anyone can burn a host's budget without holding any osu! credential.
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;

function schedulerToken(): string {
  if (cachedToken !== null) return cachedToken;
  if (config.token) return (cachedToken = config.token);
  try {
    cachedToken = readFileSync(config.tokenFile, 'utf8').trim();
  } catch {
    log.error('no scheduler token configured; the proxy will refuse every caller', {
      hint: 'set SCHEDULER_TOKEN or create SCHEDULER_TOKEN_FILE',
      file: config.tokenFile,
    });
    cachedToken = '';
  }
  return cachedToken;
}

function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function schedulerTokenValid(presented: string | undefined): boolean {
  const want = schedulerToken();
  // No configured token means refuse everyone, rather than admit everyone.
  if (!want || !presented) return false;
  return constantTimeEquals(presented, want);
}

// ---------------------------------------------------------------------------
// Dashboard sign-in. Three modes -- osu! OAuth is not mandatory, because a
// self-hosted tool often already sits behind something that authenticates.
//
//   oauth    osu! OAuth, restricted to an allowlist of osu! ids
//   password one shared password
//   none     no check here; the reverse proxy is doing it
//
// Within oauth there are two ways to complete the round trip:
//
//  1. Standard osu! OAuth, the normal case: register an application whose
//     callback is <origin>/auth/callback and set the client id/secret.
//  2. Handoff, for when your osu! application's single callback URL is already
//     spoken for by another site. That site identifies the user and hands back
//     a short-lived HMAC assertion, so no second application is needed.
//
// Either way only osu! ids on the allowlist are admitted.
// ---------------------------------------------------------------------------

export type AuthMode = 'oauth' | 'password' | 'none';

let warnedOpen = false;

/** Explicit setting, else inferred from what is configured. */
export function authMode(): AuthMode {
  const explicit = config.dashboardAuth.toLowerCase();
  if (explicit === 'oauth' || explicit === 'password' || explicit === 'none') return explicit;

  if (config.oauthClientId || config.handoffSecretFile) return 'oauth';
  if (config.dashboardPassword) return 'password';

  if (!warnedOpen) {
    warnedOpen = true;
    log.warn('dashboard has no authentication configured and is open to anyone who can reach it', {
      fix: 'set DASHBOARD_AUTH=oauth|password, or put it behind proxy auth and set DASHBOARD_AUTH=none',
    });
  }
  return 'none';
}

let cachedSessionSecret: string | null = null;

function sessionSecret(): string {
  if (cachedSessionSecret !== null) return cachedSessionSecret;
  try {
    cachedSessionSecret = readFileSync(config.sessionSecretFile, 'utf8').trim();
  } catch {
    // Generate one rather than making first run a configuration puzzle. Losing
    // it only signs everyone out.
    const generated = randomBytes(32).toString('hex');
    try {
      mkdirSync(dirname(config.sessionSecretFile), { recursive: true });
      writeFileSync(config.sessionSecretFile, generated, { mode: 0o600 });
      log.info('generated a dashboard session secret', { file: config.sessionSecretFile });
    } catch (err) {
      log.warn('could not persist the session secret; sessions end at restart', {
        err: String(err),
      });
    }
    cachedSessionSecret = generated;
  }
  return cachedSessionSecret;
}

function hmac(payload: string, key = sessionSecret()): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function handoffEnabled(): boolean {
  return Boolean(config.handoffSecretFile && config.handoffAuthorizeUrl);
}

function handoffSecret(): string {
  try {
    return readFileSync(config.handoffSecretFile, 'utf8').trim();
  } catch {
    log.error('handoff secret unreadable; sign-in will refuse everyone', {
      file: config.handoffSecretFile,
    });
    return '';
  }
}

/** Nonces we handed out, so an assertion or code cannot be replayed. */
const pendingNonces = new Map<string, number>();
const NONCE_TTL_MS = 10 * 60_000;

function sweepNonces() {
  const now = Date.now();
  for (const [n, born] of pendingNonces) if (now - born > NONCE_TTL_MS) pendingNonces.delete(n);
}

export function isAllowed(uid: number): boolean {
  return config.dashboardAllowedIds.includes(uid);
}

/** Constant-time check of the shared dashboard password. */
export function passwordValid(presented: string): boolean {
  if (!config.dashboardPassword) return false;
  return constantTimeEquals(presented, config.dashboardPassword);
}

/** Session subject for password mode, where there is no osu! id involved. */
export const PASSWORD_SUBJECT = -1;

/** Where to send someone who wants to sign in. */
export function beginLogin(): { url: string } | { error: string } {
  sweepNonces();
  const nonce = randomBytes(16).toString('hex');
  pendingNonces.set(nonce, Date.now());

  if (handoffEnabled()) {
    const u = new URL(config.handoffAuthorizeUrl);
    u.searchParams.set('state', `dash:${nonce}`);
    return { url: u.toString() };
  }

  if (!config.oauthClientId || !config.oauthClientSecret) {
    return {
      error:
        'Dashboard sign-in is not configured. Set DASHBOARD_OSU_CLIENT_ID and ' +
        'DASHBOARD_OSU_CLIENT_SECRET, or configure the handoff mode.',
    };
  }

  const u = new URL(`${config.upstreamBase}/oauth/authorize`);
  u.searchParams.set('client_id', config.oauthClientId);
  u.searchParams.set('redirect_uri', `${config.dashboardOrigin}/auth/callback`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'identify');
  u.searchParams.set('state', nonce);
  return { url: u.toString() };
}

function consumeNonce(nonce: string): boolean {
  sweepNonces();
  if (!pendingNonces.has(nonce)) return false;
  pendingNonces.delete(nonce);
  return true;
}

/** Standard OAuth: exchange the code, then ask osu! who it belongs to. */
export async function completeOauth(
  code: string,
  state: string,
): Promise<{ ok: true; uid: number } | { ok: false; why: string }> {
  if (!consumeNonce(state)) return { ok: false, why: 'unknown or already used state' };

  const tokenRes = await fetch(`${config.upstreamBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: config.oauthClientId,
      client_secret: config.oauthClientSecret,
      grant_type: 'authorization_code',
      redirect_uri: `${config.dashboardOrigin}/auth/callback`,
      code,
    }),
  });
  const token = (await tokenRes.json().catch(() => null)) as { access_token?: string } | null;
  if (!tokenRes.ok || !token?.access_token) {
    return { ok: false, why: `token exchange failed (${tokenRes.status})` };
  }

  // Deliberately direct, not through our own queue: sign-in must work even when
  // the budget is exhausted, and it is one request by one person.
  const meRes = await fetch(`${config.upstreamBase}/api/v2/me`, {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
  });
  const me = (await meRes.json().catch(() => null)) as { id?: number } | null;
  if (!meRes.ok || !me?.id) return { ok: false, why: `could not read the profile (${meRes.status})` };

  if (!isAllowed(me.id)) return { ok: false, why: `osu! id ${me.id} is not on the allowlist` };
  return { ok: true, uid: me.id };
}

export interface Assertion {
  uid: number;
  nonce: string;
  exp: number;
  sig: string;
}

/** Handoff mode: verify the assertion the other site handed back. */
export function verifyAssertion(a: Assertion): { ok: true; uid: number } | { ok: false; why: string } {
  const secret = handoffSecret();
  if (!secret) return { ok: false, why: 'no handoff secret configured' };
  if (!Number.isFinite(a.uid) || !a.nonce || !Number.isFinite(a.exp)) {
    return { ok: false, why: 'malformed' };
  }
  if (Date.now() > a.exp) return { ok: false, why: 'expired' };
  if (!consumeNonce(a.nonce)) return { ok: false, why: 'unknown or already used nonce' };

  if (!safeEqualHex(hmac(`${a.uid}:${a.nonce}:${a.exp}`, secret), a.sig)) {
    return { ok: false, why: 'bad signature' };
  }
  if (!isAllowed(a.uid)) return { ok: false, why: `osu! id ${a.uid} is not on the allowlist` };
  return { ok: true, uid: a.uid };
}

// ---- session cookie -------------------------------------------------------

const COOKIE = 'osu-api-scheduler';

export function issueSession(uid: number): string {
  const exp = Date.now() + config.sessionTtlMs;
  const body = `${uid}:${exp}`;
  return `${body}:${hmac(body)}`;
}

/**
 * Whether this request may see the dashboard. In `none` mode everything is
 * allowed, because something in front of us has already decided.
 */
export function isAuthed(cookieHeader: string | undefined): boolean {
  if (authMode() === 'none') return true;
  return sessionOwner(cookieHeader) !== null;
}

export function sessionOwner(cookieHeader: string | undefined): number | null {
  if (!cookieHeader) return null;
  const raw = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;

  const parts = decodeURIComponent(raw.slice(COOKIE.length + 1)).split(':');
  if (parts.length !== 3) return null;
  const [uidStr, expStr, sig] = parts as [string, string, string];

  if (!safeEqualHex(hmac(`${uidStr}:${expStr}`), sig)) return null;
  if (Date.now() > Number(expStr)) return null;

  const uid = Number(uidStr);
  // A password session carries no osu! id, so the allowlist does not apply --
  // holding a validly signed cookie is the whole claim.
  if (uid === PASSWORD_SUBJECT) return authMode() === 'password' ? uid : null;
  return isAllowed(uid) ? uid : null;
}

export function cookieHeader(value: string, maxAgeS: number): string {
  // HttpOnly: the page never needs to read this, and it is the whole session.
  // Secure only when the origin is https, or local http setups cannot sign in.
  const secure = config.dashboardOrigin.startsWith('https://') ? ' Secure;' : '';
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAgeS}`;
}
