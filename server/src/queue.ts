import { TIERS, type Tier, config } from './config.js';

export interface JobRequest {
  method: string;
  /** Path below the upstream origin, e.g. "api/v2/users/123/mania". */
  path: string;
  query: string;
  body: string | null;
  /** Passed through verbatim, including the caller's own Authorization. */
  headers: Record<string, string>;
}

export interface Job {
  id: number;
  tier: Tier;
  /** Who asked, taken from the User-Agent. "unknown" if it did not say. */
  consumer: string;
  request: JobRequest;
  enqueuedAt: number;
  /** Epoch ms, or Infinity for a job that must never be dropped. */
  deadline: number;
  /** Upstream tries that did not produce a verdict (401 re-auth, 429 bounce). */
  attempts: number;
  settle: (r: JobResult) => void;
}

export type JobResult =
  | { ok: true; status: number; headers: Record<string, string>; body: string; waitedMs: number }
  | { ok: false; reason: 'timeout' | 'shutdown'; waitedMs: number };

let nextId = 1;

/**
 * One FIFO per tier rather than a single heap.
 *
 * Aging means a job's effective priority changes as it sits, which a heap
 * cannot express without re-sorting. But within one tier every job shares a
 * base priority, so the oldest is always the most-aged: only the head of each
 * tier can ever win. That makes selection O(number of tiers) with no re-sort,
 * and there are five tiers.
 */
export class PriorityQueue {
  private lanes = new Map<Tier, Job[]>();
  private total = 0;

  constructor() {
    for (const tier of Object.keys(TIERS) as Tier[]) this.lanes.set(tier, []);
  }

  get size(): number {
    return this.total;
  }

  get isFull(): boolean {
    return this.total >= config.maxQueue;
  }

  depths(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [tier, lane] of this.lanes) out[tier] = lane.length;
    return out;
  }

  /**
   * How long the oldest waiter in each lane has been queued. This is the honest
   * measure of whether a level is keeping up: depth alone says nothing, because
   * a deep queue that drains fast is fine and a shallow one that never moves is
   * not.
   */
  oldestWaitMs(now = Date.now()): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [tier, lane] of this.lanes) {
      const head = lane[0];
      out[tier] = head ? now - head.enqueuedAt : 0;
    }
    return out;
  }

  push(
    tier: Tier,
    consumer: string,
    request: JobRequest,
    maxWaitMs: number,
    settle: (r: JobResult) => void,
  ): Job {
    const now = Date.now();
    const job: Job = {
      id: nextId++,
      tier,
      consumer,
      request,
      enqueuedAt: now,
      deadline: now + maxWaitMs,
      attempts: 0,
      settle,
    };
    this.lanes.get(tier)!.push(job);
    this.total++;
    return job;
  }

  /**
   * Put a job back at the head of its lane. Used when a send was refused
   * before osu! judged it (a 429 bounce, or a retry after re-reading the
   * token): it already waited its turn, so it should not go to the back.
   */
  pushFront(job: Job): void {
    this.lanes.get(job.tier)!.unshift(job);
    this.total++;
  }

  /** Effective priority: lower is better, improving as the job waits. */
  private effective(job: Job, now: number): number {
    const aged = Math.floor((now - job.enqueuedAt) / config.agingStepMs) * config.agingStep;
    return TIERS[job.tier] - aged;
  }

  /**
   * Settle everything past its deadline; callers get a 504 rather than a hang.
   * A job submitted with an infinite deadline is never picked up here -- it
   * leaves the queue only by being served or by shutdown.
   */
  expire(now = Date.now()): number {
    let expired = 0;
    for (const [, lane] of this.lanes) {
      for (let i = lane.length - 1; i >= 0; i--) {
        const job = lane[i]!;
        if (job.deadline <= now) {
          lane.splice(i, 1);
          this.total--;
          expired++;
          job.settle({ ok: false, reason: 'timeout', waitedMs: now - job.enqueuedAt });
        }
      }
    }
    return expired;
  }

  /**
   * Best waiting job that `canSend` accepts.
   *
   * The predicate exists because whether a job may go depends on its tier, not
   * just on its turn: bulk tiers are barred from the reserved part of the burst
   * bucket. Skipping a blocked head and trying the next tier is what lets a
   * latency-sensitive job past a bulk queue that cannot afford to move.
   */
  /**
   * What is waiting, in the order it will actually be served -- effective
   * priority, aging included. Counts alone do not tell you whether the thing
   * you are waiting on is next or behind four hundred others.
   */
  peek(limit: number, now = Date.now()): {
    tier: Tier;
    consumer: string;
    path: string;
    waitedMs: number;
    position: number;
  }[] {
    const all: { job: Job; score: number }[] = [];
    for (const [, lane] of this.lanes) {
      for (const job of lane) all.push({ job, score: this.effective(job, now) });
    }
    // Within a lane order is already FIFO; across lanes, effective priority
    // decides, with the older job first on a tie.
    all.sort((a, b) => a.score - b.score || a.job.enqueuedAt - b.job.enqueuedAt);
    return all.slice(0, limit).map(({ job }, i) => ({
      tier: job.tier,
      consumer: job.consumer,
      path: job.request.path,
      waitedMs: now - job.enqueuedAt,
      position: i + 1,
    }));
  }

  take(canSend: (tier: Tier) => boolean = () => true, now = Date.now()): Job | null {
    const heads: { tier: Tier; score: number }[] = [];
    for (const [tier, lane] of this.lanes) {
      const head = lane[0];
      if (!head) continue;
      heads.push({ tier, score: this.effective(head, now) });
    }
    heads.sort((a, b) => a.score - b.score);
    for (const { tier } of heads) {
      if (!canSend(tier)) continue;
      const job = this.lanes.get(tier)!.shift()!;
      this.total--;
      return job;
    }
    return null;
  }

  drain(reason: 'shutdown'): void {
    const now = Date.now();
    for (const [, lane] of this.lanes) {
      for (const job of lane.splice(0)) {
        job.settle({ ok: false, reason, waitedMs: now - job.enqueuedAt });
      }
    }
    this.total = 0;
  }
}
