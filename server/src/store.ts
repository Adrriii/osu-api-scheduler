import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

export interface RequestRecord {
  ts: number;
  consumer: string;
  tier: string;
  path: string;
  status: number;
  waitedMs: number;
  /** Null when the request was served; otherwise which limiter refused it. */
  limiter: string | null;
  /** Time osu! itself took, separate from time spent waiting in our queue. */
  upstreamMs: number;
}

interface Agg {
  n: number;
  refused: number;
  errors: number;
  waitedSum: number;
  upstreamSum: number;
}

const emptyAgg = (): Agg => ({ n: 0, refused: 0, errors: 0, waitedSum: 0, upstreamSum: 0 });

function add(into: Agg, r: RequestRecord): void {
  into.n += 1;
  if (r.limiter) into.refused += 1;
  else if (r.status >= 400) into.errors += 1;
  into.waitedSum += r.waitedMs;
  into.upstreamSum += r.upstreamMs;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Latency is always reported over this much recent traffic, whatever range the
 * page is showing. It is the one figure that needs individual values rather
 * than sums, and an hour of those is what is held in memory. Stretching it to
 * match the selected range would mean either storing every request forever or
 * quietly reporting a recent number under a longer heading.
 */
const LATENCY_WINDOW_MS = HOUR;

/**
 * Live detail in memory, history on disk as aggregates.
 *
 * Individual requests are only interesting while they are recent: the feed, the
 * last hour's shape, a median latency. None of that is worth a row on disk per
 * request. Measured, one row per request with its indexes is 111 bytes, so
 * 60 req/min kept for 45 days is about 413 MB, which is not a thing to leave on
 * someone's server for a dashboard.
 *
 * So:
 *   in memory   the last N requests, per-minute buckets for a couple of hours,
 *               and a latency sample per level
 *   hourly      one row per hour per consumer per level, kept ~90 days
 *   daily       the same rolled to a day, kept for years
 *
 * Hourly is roughly 15 rows an hour instead of 3,600. Daily is 15 a day, so a
 * decade of the usage panel costs about 4 MB and 90 days of hourly detail about
 * 2 MB: call it 6 MB against 413. Both are written on flush rather than daily
 * being derived later, so the long view is complete right up to the last hour.
 *
 * What it costs: a restart forgets the feed and the minute-level shape, and
 * medians only exist inside the in-memory window.
 */
class Store {
  private db: DatabaseSync;
  private upsert: ReturnType<DatabaseSync['prepare']>;
  private upsertDay: ReturnType<DatabaseSync['prepare']>;

  /** Ring of recent requests, for the live feed. */
  private feed: RequestRecord[] = [];

  /** Per-minute buckets, keyed minute -> "consumer\ttier". */
  private minutes = new Map<number, Map<string, Agg>>();

  /** Recent latencies per level, timestamped so the window is a fixed hour. */
  private samples = new Map<string, { ts: number; waited: number; upstream: number }[]>();

  /** Hours not yet written to disk. Flushed before any read, and on a timer. */
  private pending = new Map<number, Map<string, Agg>>();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    // Hand freed pages back to the filesystem. Without this a DELETE only marks
    // pages reusable and the file never shrinks, which defeats retention.
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_hourly (
        hour            INTEGER NOT NULL,
        consumer        TEXT    NOT NULL,
        tier            TEXT    NOT NULL,
        n               INTEGER NOT NULL,
        refused         INTEGER NOT NULL,
        errors          INTEGER NOT NULL,
        waited_ms_sum   INTEGER NOT NULL,
        upstream_ms_sum INTEGER NOT NULL,
        PRIMARY KEY (hour, consumer, tier)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS request_daily (
        day             INTEGER NOT NULL,
        consumer        TEXT    NOT NULL,
        tier            TEXT    NOT NULL,
        n               INTEGER NOT NULL,
        refused         INTEGER NOT NULL,
        errors          INTEGER NOT NULL,
        waited_ms_sum   INTEGER NOT NULL,
        upstream_ms_sum INTEGER NOT NULL,
        PRIMARY KEY (day, consumer, tier)
      ) WITHOUT ROWID;
    `);
    // A pre-aggregation database has a per-request table. It is not worth
    // migrating: the aggregates it would produce are for a window that has
    // already scrolled off the dashboard.
    this.db.exec('DROP TABLE IF EXISTS request');

    const upsertInto = (table: string, col: string) =>
      this.db.prepare(
        `INSERT INTO ${table} (${col}, consumer, tier, n, refused, errors, waited_ms_sum, upstream_ms_sum)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(${col}, consumer, tier) DO UPDATE SET
           n               = n + excluded.n,
           refused         = refused + excluded.refused,
           errors          = errors + excluded.errors,
           waited_ms_sum   = waited_ms_sum + excluded.waited_ms_sum,
           upstream_ms_sum = upstream_ms_sum + excluded.upstream_ms_sum`,
      );
    this.upsert = upsertInto('request_hourly', 'hour');
    this.upsertDay = upsertInto('request_daily', 'day');
  }

  /** How far back the in-memory minute buckets reach. */
  private get memoryHorizonMs(): number {
    return config.liveMinutes * MINUTE;
  }

  record(r: RequestRecord): void {
    const key = `${r.consumer}\t${r.tier}`;

    this.feed.unshift(r);
    if (this.feed.length > config.feedSize) this.feed.length = config.feedSize;

    const minute = Math.floor(r.ts / MINUTE) * MINUTE;
    let m = this.minutes.get(minute);
    if (!m) this.minutes.set(minute, (m = new Map()));
    let a = m.get(key);
    if (!a) m.set(key, (a = emptyAgg()));
    add(a, r);

    const hour = Math.floor(r.ts / HOUR) * HOUR;
    let h = this.pending.get(hour);
    if (!h) this.pending.set(hour, (h = new Map()));
    let ha = h.get(key);
    if (!ha) h.set(key, (ha = emptyAgg()));
    add(ha, r);

    let s = this.samples.get(r.tier);
    if (!s) this.samples.set(r.tier, (s = []));
    s.push({ ts: r.ts, waited: r.waitedMs, upstream: r.upstreamMs });
    // Bounded twice: by age just below, and by count here so a burst cannot
    // grow this without limit.
    if (s.length > config.latencySamples) s.shift();
    const sampleCutoff = r.ts - LATENCY_WINDOW_MS;
    while (s.length && s[0]!.ts < sampleCutoff) s.shift();

    // Drop minute buckets that have scrolled out of the live window.
    const cutoff = Date.now() - this.memoryHorizonMs;
    for (const t of this.minutes.keys()) if (t < cutoff) this.minutes.delete(t);
  }

  /** Write pending hours to disk. Cheap: a handful of rows. */
  flush(): void {
    if (!this.pending.size) return;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      for (const [hour, byKey] of this.pending) {
        for (const [key, a] of byKey) {
          const [consumer, tier] = key.split('\t') as [string, string];
          const args = [a.n, a.refused, a.errors, a.waitedSum, a.upstreamSum] as const;
          this.upsert.run(hour, consumer, tier, ...args);
          // Written alongside rather than derived when hourly expires, so the
          // multi-year view is complete right up to the current hour.
          this.upsertDay.run(Math.floor(hour / DAY) * DAY, consumer, tier, ...args);
        }
      }
      this.db.exec('COMMIT');
      this.pending.clear();
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Already rolled back.
      }
      // Keep `pending` so the next flush retries rather than losing the counts.
      log.error('metrics flush failed', { err: String(err) });
    }
  }

  /** True when the window is short enough to answer from memory. */
  private inMemory(sinceMs: number): boolean {
    return sinceMs >= Date.now() - this.memoryHorizonMs;
  }

  private fromMemory(sinceMs: number): { key: string; agg: Agg }[] {
    const out = new Map<string, Agg>();
    for (const [t, byKey] of this.minutes) {
      if (t < sinceMs) continue;
      for (const [key, a] of byKey) {
        let into = out.get(key);
        if (!into) out.set(key, (into = emptyAgg()));
        into.n += a.n;
        into.refused += a.refused;
        into.errors += a.errors;
        into.waitedSum += a.waitedSum;
        into.upstreamSum += a.upstreamSum;
      }
    }
    return [...out].map(([key, agg]) => ({ key, agg }));
  }

  /**
   * Which stored resolution answers a window. Hourly only reaches back
   * `hourlyRetentionDays`; past that only the daily rows survive.
   */
  private source(sinceMs: number): { table: string; col: string; grain: number } {
    const hourlyReach = Date.now() - config.hourlyRetentionDays * DAY;
    return sinceMs >= hourlyReach
      ? { table: 'request_hourly', col: 'hour', grain: HOUR }
      : { table: 'request_daily', col: 'day', grain: DAY };
  }

  private fromDisk(sinceMs: number): { key: string; agg: Agg }[] {
    this.flush();
    const { table, col, grain } = this.source(sinceMs);
    return (
      this.db
        .prepare(
          `SELECT consumer, tier, SUM(n) AS n, SUM(refused) AS refused, SUM(errors) AS errors,
                  SUM(waited_ms_sum) AS w, SUM(upstream_ms_sum) AS u
           FROM ${table} WHERE ${col} >= ? GROUP BY consumer, tier`,
        )
        .all(Math.floor(sinceMs / grain) * grain) as Record<string, unknown>[]
    ).map((r) => ({
      key: `${String(r.consumer)}\t${String(r.tier)}`,
      agg: {
        n: Number(r.n),
        refused: Number(r.refused),
        errors: Number(r.errors),
        waitedSum: Number(r.w),
        upstreamSum: Number(r.u),
      },
    }));
  }

  /**
   * Short windows come from memory and are exact to the minute. Longer ones
   * come from the hourly rows, so they round outward to the hour.
   */
  private slice(sinceMs: number) {
    return this.inMemory(sinceMs) ? this.fromMemory(sinceMs) : this.fromDisk(sinceMs);
  }

  summary(sinceMs: number) {
    const rows = this.slice(sinceMs);

    const totals = emptyAgg();
    const byConsumer = new Map<string, Agg>();
    const byTier = new Map<string, Agg>();

    for (const { key, agg } of rows) {
      const [consumer, tier] = key.split('\t') as [string, string];
      for (const [map, k] of [[byConsumer, consumer], [byTier, tier]] as const) {
        let into = map.get(k);
        if (!into) map.set(k, (into = emptyAgg()));
        into.n += agg.n;
        into.refused += agg.refused;
        into.errors += agg.errors;
        into.waitedSum += agg.waitedSum;
        into.upstreamSum += agg.upstreamSum;
      }
      totals.n += agg.n;
      totals.refused += agg.refused;
      totals.errors += agg.errors;
      totals.waitedSum += agg.waitedSum;
    }

    const avg = (a: Agg) => (a.n ? Math.round(a.waitedSum / a.n) : 0);

    return {
      totals: {
        requests: totals.n,
        served: totals.n - totals.refused,
        refused: totals.refused,
        errors: totals.errors,
        avgWaitMs: avg(totals),
      },
      byConsumer: [...byConsumer]
        .map(([consumer, a]) => ({ consumer, n: a.n, avgWaitMs: avg(a) }))
        .sort((x, y) => y.n - x.n),
      byTier: [...byTier]
        .map(([tier, a]) => ({
          tier, n: a.n, avgWaitMs: avg(a), refused: a.refused, errors: a.errors,
        }))
        .sort((x, y) => y.n - x.n),
    };
  }

  /**
   * Latency per level as the consumer experiences it: from the request reaching
   * the scheduler to it having a response, queue wait included.
   *
   * Both the mean and the median cover the last hour, not the selected range.
   * They come from the in-memory samples, which is the only place individual
   * values exist. Reporting a mean over a year from stored sums while the
   * median beside it covered an hour would put two different questions in one
   * column.
   */
  latencyByTier() {
    const cutoff = Date.now() - LATENCY_WINDOW_MS;
    const out: Record<string, {
      n: number;
      windowMs: number;
      avgTotalMs: number;
      medTotalMs: number | null;
      avgUpstreamMs: number;
    }> = {};

    for (const [tier, all] of this.samples) {
      const recent = all.filter((x) => x.ts >= cutoff);
      if (!recent.length) continue;

      const waited = recent.map((x) => x.waited).sort((a, b) => a - b);
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

      out[tier] = {
        n: recent.length,
        windowMs: LATENCY_WINDOW_MS,
        avgTotalMs: Math.round(sum(waited) / waited.length),
        medTotalMs: Math.round(waited[Math.floor(waited.length / 2)] ?? 0),
        avgUpstreamMs: Math.round(sum(recent.map((x) => x.upstream)) / recent.length),
      };
    }
    return out;
  }

  /** Counts per bucket, with empty buckets filled so the chart has no gaps. */
  series(sinceMs: number, bucketMs: number, untilMs = Date.now()) {
    const found = new Map<number, { n: number; refused: number }>();
    const bucketOf = (t: number) => Math.floor(t / bucketMs) * bucketMs;

    if (this.inMemory(sinceMs)) {
      for (const [t, byKey] of this.minutes) {
        if (t < sinceMs || t >= untilMs) continue;
        const b = bucketOf(t);
        const into = found.get(b) ?? { n: 0, refused: 0 };
        for (const a of byKey.values()) {
          into.n += a.n;
          into.refused += a.refused;
        }
        found.set(b, into);
      }
    } else {
      this.flush();
      const { table, col, grain } = this.source(sinceMs);
      for (const r of this.db
        .prepare(
          `SELECT ${col} AS t, SUM(n) AS n, SUM(refused) AS refused FROM ${table}
           WHERE ${col} >= ? AND ${col} < ? GROUP BY ${col}`,
        )
        .all(Math.floor(sinceMs / grain) * grain, untilMs) as Record<string, unknown>[]) {
        const b = bucketOf(Number(r.t));
        const into = found.get(b) ?? { n: 0, refused: 0 };
        into.n += Number(r.n);
        into.refused += Number(r.refused);
        found.set(b, into);
      }
    }

    const out: { t: number; n: number; refused: number }[] = [];
    for (let t = bucketOf(sinceMs); t < untilMs; t += bucketMs) {
      const hit = found.get(t);
      out.push({ t, n: hit?.n ?? 0, refused: hit?.refused ?? 0 });
    }
    return out;
  }

  seriesByConsumer(sinceMs: number, bucketMs: number, untilMs = Date.now()) {
    const out: { t: number; consumer: string; n: number }[] = [];
    const bucketOf = (t: number) => Math.floor(t / bucketMs) * bucketMs;
    const acc = new Map<string, number>();

    const put = (t: number, consumer: string, n: number) => {
      const k = `${bucketOf(t)}\t${consumer}`;
      acc.set(k, (acc.get(k) ?? 0) + n);
    };

    if (this.inMemory(sinceMs)) {
      for (const [t, byKey] of this.minutes) {
        if (t < sinceMs || t >= untilMs) continue;
        for (const [key, a] of byKey) put(t, key.split('\t')[0] as string, a.n);
      }
    } else {
      this.flush();
      const { table, col, grain } = this.source(sinceMs);
      for (const r of this.db
        .prepare(
          `SELECT ${col} AS t, consumer, SUM(n) AS n FROM ${table}
           WHERE ${col} >= ? AND ${col} < ? GROUP BY ${col}, consumer`,
        )
        .all(Math.floor(sinceMs / grain) * grain, untilMs) as Record<string, unknown>[]) {
        put(Number(r.t), String(r.consumer), Number(r.n));
      }
    }

    for (const [k, n] of acc) {
      const [t, consumer] = k.split('\t') as [string, string];
      out.push({ t: Number(t), consumer, n });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  recent(limit = 200) {
    return this.feed.slice(0, limit).map((r) => ({
      ts: r.ts,
      consumer: r.consumer,
      tier: r.tier,
      path: r.path,
      status: r.status,
      waitedMs: r.waitedMs,
      limiter: r.limiter,
    }));
  }

  /** Drop hourly rows past the retention window and release the pages. */
  prune(): void {
    try {
      this.flush();
      // Hourly is the detail tier and expires first; daily is the cheap one
      // that keeps the usage panel going back years.
      this.db
        .prepare('DELETE FROM request_hourly WHERE hour < ?')
        .run(Date.now() - config.hourlyRetentionDays * DAY);
      this.db
        .prepare('DELETE FROM request_daily WHERE day < ?')
        .run(Date.now() - config.retentionDays * DAY);
      this.db.exec('PRAGMA incremental_vacuum(2000)');
    } catch (err) {
      log.error('prune failed', { err: String(err) });
    }
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}

export const store = new Store(config.dbPath);

store.prune();
// Flush often enough that a hard kill loses little, cheap enough not to matter.
setInterval(() => store.flush(), 30_000).unref();
setInterval(() => store.prune(), HOUR).unref();
