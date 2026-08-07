import { readFileSync, writeFileSync } from 'node:fs';
import { TIERS, config, paceIntervalMs, type Tier } from './config.js';
import { log } from './log.js';
import { PriorityQueue, type Job, type JobRequest, type JobResult } from './queue.js';
import { send, type Limiter } from './upstream.js';
import { store, type RequestRecord } from './store.js';

/**
 * Backoff mirrored to disk: read at startup so a restart mid-lockout does not
 * walk straight back into it, and readable by anything not yet routed through
 * the scheduler so it can back off too.
 */
const BAN_MIRROR = config.banMirrorFile;

interface Stats {
  served: number;
  failed: number;
  expired: number;
  /** Counted per limiter, because they mean very different things. */
  limited: Record<Limiter, number>;
  perTier: Record<string, { served: number; waitMsTotal: number }>;
}

export class Scheduler {
  readonly queue = new PriorityQueue();

  private inFlight = 0;
  private lastSendAt = 0;
  private bannedUntil = 0;

  /**
   * Token bucket mirroring the upstream one: refills at the sustained rate,
   * caps at the burst allowance. Idle time banks capacity, which is what lets a
   * backlog drain fast without the long-run average ever exceeding the ceiling.
   * Empty at startup -- see config.burstCapacity for why we do not assume full.
   */
  private tokens = 0;
  private lastRefillAt = Date.now();

  /**
   * Per-level buckets. Each refills at its own share of the sustained rate and
   * banks up to its own share of the burst capacity, so a level that has been
   * quiet can then go fast without another level's backlog having spent it.
   */
  private levels: Partial<Record<Tier, number>> = {};





  private lastChallengeLog = 0;

  /** Recent challenge timestamps, to tell a one-off from a real block. */
  private challengeTimes: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  private stats: Stats = {
    served: 0,
    failed: 0,
    expired: 0,
    limited: { 'cloudflare-1015': 0, 'cloudflare-challenge': 0, osuweb: 0 },
    perTier: {},
  };

  constructor() {
    // A restart must not forget an active backoff. Without this the first job
    // after a deploy walks straight into the limiter and earns a fresh 30
    // minutes for everyone.
    try {
      const until = Number.parseInt(readFileSync(BAN_MIRROR, 'utf8').trim(), 10) * 1000;
      if (Number.isFinite(until) && until > Date.now()) {
        this.bannedUntil = until;
        log.warn('resuming an active backoff from disk', {
          seconds: Math.ceil((until - Date.now()) / 1000),
        });
      }
    } catch {
      // No mirror file means no known ban.
    }
  }

  submit(
    tier: Tier,
    consumer: string,
    request: JobRequest,
    maxWaitMs: number,
  ): Promise<JobResult> {
    return new Promise<JobResult>((resolve) => {
      this.queue.push(tier, consumer, request, maxWaitMs, resolve);
      this.pump();
    });
  }

  /** Fan-out for the dashboard's live feed. */
  private watchers = new Set<(r: RequestRecord) => void>();

  watch(fn: (r: RequestRecord) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  private observe(
    job: Job,
    status: number,
    waitedMs: number,
    limiter: string | null,
    upstreamMs: number,
  ): void {
    const rec: RequestRecord = {
      ts: Date.now(),
      consumer: job.consumer,
      tier: job.tier,
      path: job.request.path,
      status,
      waitedMs,
      limiter,
      upstreamMs,
    };
    store.record(rec);
    for (const w of this.watchers) {
      try {
        w(rec);
      } catch {
        // A broken listener must not affect the request that triggered it.
      }
    }
  }

  private get banRemainingMs(): number {
    return Math.max(0, this.bannedUntil - Date.now());
  }

  private setBan(seconds: number, limiter: Limiter): void {
    const until = Date.now() + seconds * 1000;
    // Never shorten an existing ban: a second worker's shorter retry-after
    // would otherwise let us back out early and re-trip the limiter.
    if (until <= this.bannedUntil) return;
    this.bannedUntil = until;
    try {
      writeFileSync(BAN_MIRROR, String(Math.ceil(until / 1000)));
    } catch {
      // Mirror is a convenience for legacy callers; losing it is not fatal.
    }
    log.warn('backing off', { seconds, limiter, queued: this.queue.size });
  }

  /**
   * How long to pause, by what answered. A 1015 tells us exactly how long it
   * wants; a challenge tells us nothing, and hammering it is what provokes more
   * of them, so it gets a deliberately long pause rather than the 60s default.
   */
  private backoffFor(limiter: Limiter, retryAfterS: number | null): number {
    if (retryAfterS && retryAfterS > 0) return retryAfterS;
    return limiter === 'cloudflare-challenge'
      ? config.challengeBackoffS
      : config.fallbackBackoffS;
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(1, delayMs));
  }

  private levelCapacity(tier: Tier): number {
    return config.tierBurst[tier] ?? 0;
  }

  /** Latency-critical levels: allowed to spend the protected global reserve. */
  private isFast(tier: Tier): boolean {
    return TIERS[tier] <= config.burstFreeMaxPriority;
  }

  /**
   * Whether this level may draw on *another* level's bank. Your own bank is
   * always spendable while the global bucket has anything in it -- that is what
   * a bank means, and gating it on the reserve left levels sitting on a full
   * bank with work queued for minutes, waiting on a pool they were not allowed
   * to touch. The reserve exists to stop the shared surplus being borrowed
   * away, so it applies to borrowing and nothing else.
   */
  private mayBorrow(tier: Tier): boolean {
    if (this.tokens < 1) return false;
    return this.isFast(tier) || this.tokens > config.globalReserve;
  }

  /**
   * Hand `pool` to `receivers` in proportion to their shares, capped at each
   * bank. Returns what could not be placed, so the caller can pass it on.
   */
  private distribute(pool: number, receivers: Tier[]): number {
    for (let pass = 0; pass < 3 && pool > 1e-9; pass++) {
      const open = receivers.filter((t) => (this.levels[t] ?? 0) < this.levelCapacity(t));
      const openShare = open.reduce((a, t) => a + (config.tierShareOfSustained[t] ?? 0), 0);
      if (!open.length || openShare <= 0) break;

      let used = 0;
      for (const t of open) {
        const want = pool * ((config.tierShareOfSustained[t] ?? 0) / openShare);
        const room = this.levelCapacity(t) - (this.levels[t] ?? 0);
        const give = Math.min(want, room);
        this.levels[t] = (this.levels[t] ?? 0) + give;
        used += give;
      }
      pool -= used;
      if (used <= 1e-9) break;
    }
    return pool;
  }

  /**
   * Credit elapsed time to the global bucket and to the level banks.
   *
   * The tick is split. Part follows the shares regardless of who is busy, so a
   * quiet level still accumulates the burst headroom it exists to hold. The
   * rest chases whoever actually has work queued, so the base rate does not sit
   * idle while a sweep has a backlog. Anything neither can absorb -- a full
   * bank, an empty queue -- falls through to whoever has room rather than being
   * clipped away.
   */
  private refill(): void {
    const now = Date.now();
    const msPerToken = paceIntervalMs();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;

    const gained = elapsed / msPerToken;
    this.tokens = Math.min(config.burstCapacity, this.tokens + gained);

    const all = Object.keys(TIERS) as Tier[];
    const depths = this.queue.depths();
    const waiting = all.filter((t) => depths[t]);

    // Each level's share of the base rate goes to its own bank, and it spends
    // from there -- so the base rate serves that level's own requests first and
    // only what it does not spend accumulates. The bank is the leftover, not a
    // competing claim on the rate.
    //
    // The one thing that moves is a share a level physically cannot hold: a
    // full bank has nothing left to gain, so rather than clip that credit away
    // it goes to whoever has requests waiting. That is the whole anti-waste
    // mechanic, and it deliberately does not fire before the bank is full.
    let spill = 0;
    for (const tier of all) {
      const want = gained * (config.tierShareOfSustained[tier] ?? 0);
      const room = this.levelCapacity(tier) - (this.levels[tier] ?? 0);
      const give = Math.max(0, Math.min(want, room));
      this.levels[tier] = (this.levels[tier] ?? 0) + give;
      spill += want - give;
    }

    if (spill > 1e-9) {
      const leftover = this.distribute(spill, waiting.length ? waiting : all);
      this.distribute(leftover, all);
    }

    this.lastRefillAt = now;
  }

  private pump(): void {
    if (this.stopping) return;

    this.stats.expired += this.queue.expire();

    if (this.queue.size === 0) return;

    const banMs = this.banRemainingMs;
    if (banMs > 0) return void this.schedule(Math.min(banMs, 1000));

    if (this.inFlight >= config.maxInFlight) return;

    this.refill();

    const msPerToken = paceIntervalMs();
    if (this.tokens < 1) {
      // Bucket dry: the long-run rate is the refill rate, so wait for a token.
      return void this.schedule((1 - this.tokens) * msPerToken);
    }

    // Even with tokens banked, do not empty the bucket at full speed -- a burst
    // is allowed to be fast, not instantaneous.
    const burstFloorMs = 60_000 / Math.max(1, config.burstMaxPerMin);
    const since = Date.now() - this.lastSendAt;
    if (since < burstFloorMs) return void this.schedule(burstFloorMs - since);

    // A level spends its own bank first. If that is empty it may draw on a
    // *lower* priority level's bank -- never a higher one -- taking from the
    // least important available first. That is what makes a realtime burst
    // visibly slow the sweeps down instead of being capped at the refill rate,
    // and it is one-directional, so a sweep can never eat the headroom that
    // exists for recovery. No bank ever goes negative.
    const order = (Object.keys(TIERS) as Tier[]).sort((a, b) => TIERS[a] - TIERS[b]);

    let job = this.queue.take((tier) => (this.levels[tier] ?? 0) >= 1);
    let payer: Tier | null = job ? job.tier : null;

    if (!job) {
      const depths = this.queue.depths();
      for (const tier of order) {
        if (!depths[tier] || !this.mayBorrow(tier)) continue;
        // Least important donor first, so a burst costs the cheapest work.
        const donor = [...order]
          .reverse()
          .find((t) => TIERS[t] > TIERS[tier] && (this.levels[t] ?? 0) >= 1);
        if (!donor) continue;
        job = this.queue.take((t) => t === tier);
        if (job) {
          payer = donor;
          break;
        }
      }
    }

    if (!job || !payer) {
      // Nothing has budget, or only sweeps are waiting and the global bucket is
      // down at the reserve. Wait for a refill.
      return void this.schedule(msPerToken);
    }

    this.levels[payer] = (this.levels[payer] ?? 0) - 1;

    this.tokens -= 1;
    this.lastSendAt = Date.now();
    this.inFlight++;
    void this.dispatch(job);

    // More may be sendable right away (tokens banked, in-flight slots free).
    this.schedule(burstFloorMs);
  }

  private requeueFront(job: Job): void {
    this.queue.pushFront(job);
    this.pump();
  }

  private async dispatch(job: Job): Promise<void> {
    const sentAt = Date.now();
    try {
      const res = await send(job.request);
      const upstreamMs = Date.now() - sentAt;

      if (res.limiter) {
        // Log what actually came back, not just our reading of it -- the three
        // limiters are told apart by body shape, and that is exactly the kind
        // of guess that goes stale without anyone noticing.
        this.stats.limited[res.limiter]++;
        const quiet = res.limiter === 'cloudflare-challenge'
          && Date.now() - this.lastChallengeLog < 30_000;
        if (!quiet) this.lastChallengeLog = Date.now();
        if (!quiet) log.warn('upstream refused', {
          limiter: res.limiter,
          status: res.status,
          path: job.request.path,
          contentType: res.headers['content-type'] ?? '',
          // The challenges seen here correlate with a missing x-api-version,
          // so record what we actually sent rather than guessing later.
          apiVersion: job.request.headers['x-api-version'] ?? '(none)',
          retryAfter: res.retryAfterS,
          body: res.body.slice(0, 80).replace(/\s+/g, ' '),
        });

        // A challenge is aimed at one request, not at our budget: in practice
        // only some endpoints draw one, and the rest keep answering fine.
        // Stopping the world for it means one awkward path throttles every
        // tier. So send that job to the back of its lane and carry on -- unless
        // challenges start arriving in bulk, which does look like a real block.
        if (res.limiter === 'cloudflare-challenge') {
          const now = Date.now();
          this.challengeTimes = this.challengeTimes.filter((t) => now - t < 60_000);
          this.challengeTimes.push(now);
          if (this.challengeTimes.length >= config.challengeStormThreshold) {
            this.setBan(config.challengeBackoffS, res.limiter);
            this.challengeTimes = [];
          }
          this.observe(job, res.status, now - job.enqueuedAt, res.limiter, upstreamMs);
          this.queue.push(job.tier, job.consumer, job.request, job.deadline - now, job.settle);
          this.pump();
          return;
        }

        this.observe(job, res.status, Date.now() - job.enqueuedAt, res.limiter, upstreamMs);
        this.setBan(this.backoffFor(res.limiter, res.retryAfterS), res.limiter);
        // The job never reached osu!, so it keeps its place at the head of its
        // lane. Its own deadline is what eventually gives up on it.
        this.requeueFront(job);
        return;
      }

      // A 401 is the caller's token to sort out, not ours: we hold none.
      // Pass it straight back rather than retrying something we cannot fix.

      const waitedMs = Date.now() - job.enqueuedAt;
      this.stats.served++;
      const perTier = (this.stats.perTier[job.tier] ??= { served: 0, waitMsTotal: 0 });
      perTier.served++;
      perTier.waitMsTotal += waitedMs;

      this.observe(job, res.status, waitedMs, null, upstreamMs);
      job.settle({ ok: true, status: res.status, headers: res.headers, body: res.body, waitedMs });
    } catch (err) {
      this.stats.failed++;
      // A transport failure is the broker's problem, not osu!'s verdict on the
      // request, so report it as a gateway error rather than faking a status.
      log.error('upstream request failed', { path: job.request.path, err: String(err) });
      job.settle({
        ok: true,
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'upstream request failed', detail: String(err) }),
        waitedMs: Date.now() - job.enqueuedAt,
      });
    } finally {
      this.inFlight--;
      this.pump();
    }
  }

  snapshot() {
    const perTier: Record<string, { served: number; avgWaitMs: number }> = {};
    for (const [tier, v] of Object.entries(this.stats.perTier)) {
      perTier[tier] = {
        served: v.served,
        avgWaitMs: v.served ? Math.round(v.waitMsTotal / v.served) : 0,
      };
    }
    this.refill();
    return {
      sustainedPerMin: Math.round(60_000 / paceIntervalMs()),
      burst: {
        tokens: Math.floor(this.tokens),
        capacity: config.burstCapacity,
        maxPerMin: config.burstMaxPerMin,
        reserve: config.globalReserve,
        // What the sweeps can actually reach; the rest is held for a burst.
        availableToBulk: Math.max(0, Math.floor(this.tokens - config.globalReserve)),
      },
      levels: (() => {
        const waits = this.queue.oldestWaitMs();
        const depths = this.queue.depths();
        return Object.fromEntries(
          (Object.keys(TIERS) as Tier[]).map((t) => [
            t,
            {
              share: config.tierShareOfSustained[t] ?? 0,
              perMin: Math.round((60_000 / paceIntervalMs()) * (config.tierShareOfSustained[t] ?? 0)),
              tokens: Math.floor(this.levels[t] ?? 0),
              capacity: Math.floor(this.levelCapacity(t)),
              queued: depths[t] ?? 0,
              oldestWaitMs: waits[t] ?? 0,

            },
          ]),
        );
      })(),
      paceIntervalMs: paceIntervalMs(),
      inFlight: this.inFlight,
      queued: this.queue.size,
      queueByTier: this.queue.depths(),
      bannedForS: Math.ceil(this.banRemainingMs / 1000),
      totals: {
        served: this.stats.served,
        failed: this.stats.failed,
        expired: this.stats.expired,
      },
      limited: this.stats.limited,
      queue: this.queue.peek(40),
      perTier,
    };
  }

  /**
   * Serve what is already queued, then stop.
   *
   * Two instances must never run at once -- each would hold its own token
   * bucket and spend the same per-IP budget twice, which is what earns the
   * lockout this whole service exists to avoid. So an update cannot overlap
   * old and new; the gap can only be made short and the queue can be made to
   * survive it. Failing every queued request on SIGTERM turned each restart
   * into a burst of errors at every consumer, and a consumer that reads an
   * error as an answer does real damage with it.
   *
   * Pumping continues while draining. Only new arrivals are refused, by the
   * listener closing first.
   */
  async stop(graceMs = 25_000): Promise<void> {
    const deadline = Date.now() + graceMs;
    while (this.queue.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    // Anything the grace period could not reach. It never went to osu!, so the
    // reason says so and callers can retry it.
    this.queue.drain('shutdown');
  }
}
