import { config } from './config.js';
import type { JobRequest } from './queue.js';

/**
 * Three different things answer with 429 here, and they want different
 * responses, so it is worth telling them apart rather than lumping them:
 *
 *  - `cloudflare-1015`   the per-IP rate limit. `error code: 1015`, text/plain,
 *                        always sends retry-after (~1800). The whole host is out
 *                        of budget; nothing to do but wait it out.
 *  - `cloudflare-challenge`  a bot check ("Just a moment...", text/html, no
 *                        retry-after). Not a budget problem at all -- retrying
 *                        harder makes it worse, and no amount of waiting for a
 *                        quota helps, so it gets its own pause.
 *  - `osuweb`            osu!web's own per-token limiter. Clears in seconds.
 */
export type Limiter = 'cloudflare-1015' | 'cloudflare-challenge' | 'osuweb';

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Set when osu! (or Cloudflare in front of it) told us to back off. */
  retryAfterS: number | null;
  /** Which limiter answered, when one did. */
  limiter: Limiter | null;
}

export function classify(status: number, contentType: string, body: string): Limiter | null {
  const challenge =
    contentType.includes('text/html') ||
    body.includes('Just a moment') ||
    body.trimStart().startsWith('<!DOCTYPE');
  // A challenge can arrive on a 403 or 503 too, not only a 429.
  if (challenge && (status === 429 || status === 403 || status === 503)) {
    return 'cloudflare-challenge';
  }
  if (status !== 429) return null;
  if (body.includes('error code: 1015')) return 'cloudflare-1015';
  return 'osuweb';
}

export async function send(request: JobRequest): Promise<UpstreamResponse> {
  const url = `${config.upstreamBase}/${request.path}${request.query ? `?${request.query}` : ''}`;

  // Auth belongs entirely to the caller. Each app already has its own osu!
  // client and token; the broker owns the *budget*, not the identity, and it
  // holds no credentials of its own to leak or keep in sync.
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...request.headers,
  };

  // Always present a User-Agent though. PHP's curl sends none at all unless
  // told to, and unidentified traffic is what Cloudflare puts a bot challenge
  // in front of -- which then stalls every tier for the whole backoff.
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = config.userAgent;
  }

  const res = await fetch(url, {
    method: request.method,
    headers,
    body: request.body ?? undefined,
    signal: AbortSignal.timeout(config.requestTimeoutMs),
    redirect: 'follow',
  });

  const body = await res.text();

  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });

  const retryAfterRaw = res.headers.get('retry-after');
  const retryAfter = retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) : Number.NaN;

  return {
    status: res.status,
    headers: outHeaders,
    body,
    retryAfterS: Number.isFinite(retryAfter) ? retryAfter : null,
    limiter: classify(res.status, outHeaders['content-type'] ?? '', body),
  };
}
