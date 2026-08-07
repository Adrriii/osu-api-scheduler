import { useI18n, fill } from '../i18n/index.js';
import { seriesColors } from '../theme.js';
import type { RequestRow, Snapshot, Summary } from '../types.js';

const sec = (ms: number) => (ms / 1000).toFixed(1);
const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const pad2 = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

type T = ReturnType<typeof useI18n>['t'];

/**
 * Waiting time, said the way a person would. "412s" makes you do arithmetic
 * before you can tell whether it is bad.
 */
function waited(ms: number, t: T): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return fill(t.units.seconds, { n: s });
  if (s < 5400) return fill(t.units.minutes, { n: Math.round(s / 60) });
  return fill(t.units.hours, { n: (s / 3600).toFixed(1) });
}

/**
 * Severity from head-of-line wait, not queue depth: a deep queue that drains
 * fast is fine, a shallow one that never moves is not. Every level and the
 * headline are graded on the same scale, so the words mean the same thing in
 * both places. Colour always ships with an icon and a word.
 */
const GRADES = [
  { over: 300, key: 'stalled', icon: '✕', cls: 'critical' },
  { over: 60, key: 'behind', icon: '▲', cls: 'serious' },
  { over: 15, key: 'busy', icon: '▲', cls: 'warning' },
  { over: -1, key: 'keepingUp', icon: '●', cls: 'good' },
] as const;

function grade(oldestWaitMs: number) {
  const s = oldestWaitMs / 1000;
  return GRADES.find((g) => s > g.over)!;
}

function health(v: { queued: number; oldestWaitMs: number }, t: T) {
  if (!v.queued) return { label: t.levels.idle, icon: '○', cls: 'muted' };
  const g = grade(v.oldestWaitMs);
  return { label: t.levels[g.key], icon: g.icon, cls: g.cls };
}

/**
 * The headline. One sentence answering "is it fine right now", because that is
 * what the page is opened to find out. It used to be spread across a health
 * column in a table and a sub-line under a meter, so the two states that
 * actually matter -- being rate limited, and a level that has stopped moving --
 * were the least visible things on the page.
 */
function overall(s: Snapshot, t: T) {
  if (s.bannedForS > 0) {
    return {
      cls: 'critical',
      icon: '✕',
      word: t.status.backingOff,
      detail: fill(t.status.rateLimited, { v: waited(s.bannedForS * 1000, t) }),
    };
  }

  let worstLevel = '';
  let worstWait = 0;
  for (const [name, v] of Object.entries(s.levels)) {
    if (v.queued && v.oldestWaitMs > worstWait) {
      worstWait = v.oldestWaitMs;
      worstLevel = name;
    }
  }

  if (!worstLevel) {
    return {
      cls: 'good',
      icon: '●',
      word: t.status.healthy,
      detail: s.queued ? t.status.allKeepingUp : t.status.nothingQueued,
    };
  }

  const g = grade(worstWait);
  return {
    cls: g.cls,
    icon: g.icon,
    word: t.status[g.key === 'keepingUp' ? 'healthy' : g.key],
    detail: fill(t.status.levelWaiting, { level: worstLevel, v: waited(worstWait, t) }),
  };
}

/** Bounded 0-100 quantity, so it reads as a fill level rather than a fraction. */
function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="bank">
      <div className="meter" role="img" aria-label={label}>
        <i style={{ width: `${pct.toFixed(1)}%` }} />
      </div>
      <span className="bank-v tabular">{Math.round(pct)}%</span>
    </div>
  );
}

export function Status({ s, data }: { s: Snapshot; data: Summary | null }) {
  const { t } = useI18n();
  const o = overall(s, t);
  const b = s.burst;
  const pct = Math.min(100, (b.tokens / b.capacity) * 100);
  const reserveAt = (b.reserve / b.capacity) * 100;

  return (
    <section className="card hero">
      <div className={`hero-state ${o.cls}`}>
        <span className="hero-icon" aria-hidden="true">{o.icon}</span>
        <div>
          <div className="hero-word">{o.word}</div>
          <div className="hero-detail">{o.detail}</div>
        </div>
        <span className="spacer" />
        <div className="hero-counts">
          <div><span className="k">{t.status.inFlight}</span><span className="v tabular">{s.inFlight}</span></div>
          <div><span className="k">{t.status.queued}</span><span className="v tabular">{s.queued}</span></div>
          <div>
            <span className="k">{t.status.bucket}</span>
            <span className="v tabular">{b.tokens}<span className="of">/{b.capacity}</span></span>
          </div>
        </div>
      </div>

      {/* The reserve is a threshold on this same axis, so it is marked on the
          bar rather than described in a sentence underneath it. */}
      <div className="meter meter-marked" role="img"
           aria-label={`${t.status.bucket}: ${b.tokens} / ${b.capacity}`}>
        <i style={{ width: `${pct.toFixed(1)}%` }} />
        <span className="mark" style={{ left: `${reserveAt.toFixed(1)}%` }}>
          <span className="mark-label">{fill(t.status.reserve, { n: b.reserve })}</span>
        </span>
      </div>

      <p className="sub hero-foot">
        {fill(t.status.ceiling, { n: s.sustainedPerMin })} ·{' '}
        {fill(t.status.refusedBreakdown, {
          rate: s.limited['cloudflare-1015'] ?? 0,
          challenge: s.limited['cloudflare-challenge'] ?? 0,
          token: s.limited['osuweb'] ?? 0,
        })}
      </p>

      {data && (
        <div className="windows">
          {([
            [t.tiles.lastHour, data.windows.hour],
            [t.tiles.last24h, data.windows.day],
            [t.tiles.last30d, data.windows.month],
          ] as const).map(([label, w]) => (
            <div className="window" key={label}>
              <span className="k">{label}</span>
              <span className="v tabular">{fmt(w.requests)}</span>
              <span className={`m${w.refused ? ' warning' : ''}`}>
                {w.refused ? fill(t.tiles.refused, { n: w.refused }) : t.tiles.noneRefused}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function Levels({ s, latency }: { s: Snapshot; latency: Summary['latency'] }) {
  const { t } = useI18n();
  return (
    <section className="card">
      <h2>{t.levels.heading}</h2>
      <div className="scroll">
        <table className="levels">
          <colgroup>
            <col style={{ width: '13%' }} /><col style={{ width: '15%' }} />
            <col style={{ width: '15%' }} /><col style={{ width: '19%' }} />
            <col style={{ width: '9%' }} /><col style={{ width: '13%' }} />
            <col style={{ width: '8%' }} /><col style={{ width: '8%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>{t.levels.level}</th><th>{t.levels.health}</th>
              <th className="num">{t.levels.rateShare}</th>
              <th>{t.levels.bank}</th>
              <th className="num">{t.levels.queued}</th><th className="num">{t.levels.oldestWait}</th>
              <th className="num" title={t.levels.latencyHint}>{t.levels.latencyMed}</th>
              <th className="num" title={t.levels.latencyHint}>{t.levels.latencyAvg}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(s.levels).map(([k, v]) => {
              const h = health(v, t);
              const l = latency[k];
              const slow = l?.medTotalMs != null && l.medTotalMs > 30_000;
              const waitCls = v.queued ? grade(v.oldestWaitMs).cls : '';
              return (
                <tr key={k}>
                  <td className="level-name">{k}</td>
                  <td><span className={`status ${h.cls}`}>{h.icon} {h.label}</span></td>
                  <td className="num tabular">
                    {fill(t.levels.shareValue, { pct: Math.round(v.share * 100), n: v.perMin })}
                  </td>
                  <td>
                    <Meter value={v.tokens} max={v.capacity}
                           label={`${t.levels.bank}: ${v.tokens} / ${v.capacity}`} />
                  </td>
                  <td className="num tabular">{v.queued || '—'}</td>
                  <td className={`num tabular ${waitCls}`}>
                    {v.oldestWaitMs ? waited(v.oldestWaitMs, t) : '—'}
                  </td>
                  <td className={`num tabular${slow ? ' warning' : ''}`}>
                    {l?.n && l.medTotalMs !== null ? `${sec(l.medTotalMs)}s` : '—'}
                  </td>
                  <td className="num tabular muted">
                    {l?.n ? `${sec(l.avgTotalMs)}s` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Consumers({ data }: { data: Summary }) {
  const { t } = useI18n();
  const colors = seriesColors();
  const total = data.byConsumer.reduce((a, r) => a + r.n, 0) || 1;
  const top = data.byConsumer[0]?.n ?? 1;
  const rank = new Map(data.byConsumer.slice(0, 6).map((r, i) => [r.consumer, colors[i]!]));
  return (
    <section className="card">
      <h2>{t.consumers.heading}</h2>
      <div className="scroll">
        <table>
          <colgroup>
            <col style={{ width: '30%' }} /><col style={{ width: '14%' }} />
            <col style={{ width: '38%' }} /><col style={{ width: '18%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>{t.consumers.consumer}</th><th className="num">{t.consumers.requests}</th>
              <th>{t.consumers.share}</th><th className="num">{t.consumers.avgWait}</th>
            </tr>
          </thead>
          <tbody>
            {data.byConsumer.length === 0 && (
              <tr><td colSpan={4} className="empty">{t.consumers.empty}</td></tr>
            )}
            {data.byConsumer.map((r) => {
              const share = (r.n / total) * 100;
              return (
                <tr key={r.consumer}>
                  <td title={r.consumer}>
                    {rank.has(r.consumer) && (
                      <i className="swatch" style={{ background: rank.get(r.consumer) }} />
                    )}
                    {r.consumer}
                  </td>
                  <td className="num tabular">{r.n.toLocaleString()}</td>
                  {/* Bars are scaled to the largest consumer, not to the total,
                      so the differences between them stay legible when one
                      project dominates the traffic. */}
                  <td>
                    <div className="bank">
                      <div className="meter meter-flat">
                        <i style={{
                          width: `${Math.min(100, (r.n / top) * 100).toFixed(1)}%`,
                          background: rank.get(r.consumer) ?? 'var(--axis)',
                        }} />
                      </div>
                      <span className="bank-v tabular">{share.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td className="num tabular">{(r.avgWaitMs / 1000).toFixed(2)}s</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function QueuePanel({ s }: { s: Snapshot }) {
  const { t } = useI18n();
  const q = s.queue ?? [];
  const note = !s.queued
    ? t.queue.empty
    : q.length < s.queued
      ? fill(t.queue.waitingTruncated, { n: s.queued, shown: q.length })
      : fill(t.queue.waitingCount, { n: s.queued });
  return (
    <section className="card">
      <h2>{t.queue.heading} <span className="sub">{note}</span></h2>
      <div className="feed scroll">
        <table>
          <colgroup>
            <col style={{ width: '6%' }} /><col style={{ width: '24%' }} />
            <col style={{ width: '14%' }} /><col style={{ width: '38%' }} />
            <col style={{ width: '18%' }} />
          </colgroup>
          <thead>
            <tr>
              <th className="num">{t.queue.position}</th><th>{t.consumers.consumer}</th>
              <th>{t.levels.level}</th><th>{t.queue.path}</th><th className="num">{t.queue.waiting}</th>
            </tr>
          </thead>
          <tbody>
            {q.length === 0 && <tr><td colSpan={5} className="empty">{t.queue.none}</td></tr>}
            {q.map((r) => (
              <tr key={`${r.position}-${r.path}`}>
                <td className="num tabular">{r.position}</td>
                <td>{r.consumer}</td>
                <td><span className="tag">{r.tier}</span></td>
                <td className="path" title={r.path}>{r.path}</td>
                <td className={`num tabular ${grade(r.waitedMs).cls}`}>{waited(r.waitedMs, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Feed({ rows }: { rows: RequestRow[] }) {
  const { t } = useI18n();
  return (
    <section className="card">
      <h2>{t.feed.heading}</h2>
      <div className="feed scroll">
        <table>
          <colgroup>
            <col style={{ width: '13%' }} /><col style={{ width: '21%' }} />
            <col style={{ width: '14%' }} /><col style={{ width: '30%' }} />
            <col style={{ width: '12%' }} /><col style={{ width: '10%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>{t.feed.time}</th><th>{t.consumers.consumer}</th><th>{t.levels.level}</th>
              <th>{t.queue.path}</th><th className="num">{t.feed.status}</th>
              <th className="num">{t.feed.waited}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.ts}-${i}`}>
                <td className="tabular">{clock(r.ts)}</td>
                <td>{r.consumer}</td>
                <td><span className="tag">{r.tier}</span></td>
                <td className="path" title={r.path}>{r.path}</td>
                <td className={`num tabular${r.limiter ? ' warning' : r.status >= 400 ? ' critical' : ''}`}>
                  {r.limiter ? r.limiter.replace('cloudflare-', 'cf-') : r.status}
                </td>
                <td className="num tabular">{(r.waitedMs / 1000).toFixed(2)}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
