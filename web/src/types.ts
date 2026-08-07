export interface LevelState {
  share: number;
  perMin: number;
  tokens: number;
  capacity: number;
  queued: number;
  oldestWaitMs: number;
}

export interface QueuedJob {
  position: number;
  tier: string;
  consumer: string;
  path: string;
  waitedMs: number;
}

export interface Snapshot {
  /** Server clock when this was taken, so the client can correct for skew. */
  now: number;
  /** Requests delivered in a row, counted upstream so it is not capped by the feed. */
  combo: number;
  sustainedPerMin: number;
  burst: { tokens: number; capacity: number; maxPerMin: number; reserve: number; availableToBulk: number };
  levels: Record<string, LevelState>;
  paceIntervalMs: number;
  inFlight: number;
  queued: number;
  queueByTier: Record<string, number>;
  bannedForS: number;
  totals: { served: number; failed: number; expired: number };
  limited: Record<string, number>;
  queue: QueuedJob[];
  perTier: Record<string, { served: number; avgWaitMs: number }>;
}

export interface RequestRow {
  ts: number;
  consumer: string;
  tier: string;
  path: string;
  status: number;
  waitedMs: number;
  limiter: string | null;
}

export interface Latency {
  n: number;
  /** Always the last hour, independent of the selected range. */
  windowMs: number;
  avgTotalMs: number;
  medTotalMs: number | null;
  avgUpstreamMs: number;
}

export interface Totals {
  requests: number;
  served: number;
  refused: number;
  errors: number;
  avgWaitMs: number;
}

export interface Summary {
  range: 'hour' | 'day' | 'month' | 'year';
  /** Where the source for this copy lives; the AGPL notice links to it. */
  sourceUrl: string;
  version: string;
  homeUrl: string;
  homeLabel: string;
  bucketMs: number;
  now: number;
  live: Snapshot;
  totals: Totals;
  byConsumer: { consumer: string; n: number; avgWaitMs: number }[];
  byTier: { tier: string; n: number; avgWaitMs: number; refused: number; errors: number }[];
  latency: Record<string, Latency>;
  series: { t: number; n: number; refused: number }[];
  seriesByConsumer: { t: number; consumer: string; n: number }[];
  windows: { hour: Totals; day: Totals; month: Totals };
}
