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

export function Tiles({ data }: { data: Summary }) {
  const { t } = useI18n();
  const w = data.windows;
  const cards: [string, string, string][] = [
    [t.tiles.lastHour, fmt(w.hour.requests),
      w.hour.refused ? fill(t.tiles.refused, { n: w.hour.refused }) : t.tiles.noneRefused],
    [t.tiles.last24h, fmt(w.day.requests),
      fill(t.tiles.avgWait, { v: fill(t.units.seconds, { n: sec(w.day.avgWaitMs) }) })],
    [t.tiles.last30d, fmt(w.month.requests), fill(t.tiles.errorResponses, { n: w.month.errors })],
    [t.tiles.sustainedRate, fill(t.tiles.perMin, { n: data.live.sustainedPerMin }),
      fill(t.tiles.queued, { n: data.live.queued })],
  ];
  return (
    <div className="tiles">
      {cards.map(([k, v, m]) => (
        <div className="tile" key={k}>
          <div className="k">{k}</div>
          <div className="v">{v}</div>
          <div className="m">{m}</div>
        </div>
      ))}
    </div>
  );
}

export function Budget({ s }: { s: Snapshot }) {
  const { t } = useI18n();
  const b = s.burst;
  const pct = Math.min(100, (b.tokens / b.capacity) * 100);
  const reserveAt = (b.reserve / b.capacity) * 100;
  return (
    <section className="card">
      <h2>{t.budget.heading}</h2>
      <div className="stats">
        <div><div className="k">{t.budget.tokensBanked}</div>
          <div className="v">{b.tokens} <span className="of">/ {b.capacity}</span></div></div>
        <div><div className="k">{t.budget.inFlight}</div><div className="v">{s.inFlight}</div></div>
        <div><div className="k">{t.budget.queued}</div><div className="v">{s.queued}</div></div>
        <div><div className="k">{t.budget.backoff}</div>
          <div className={`v${s.bannedForS ? ' bad' : ''}`}>
            {s.bannedForS ? fill(t.units.seconds, { n: s.bannedForS }) : t.budget.none}
          </div></div>
      </div>
      <div className="meter meter-marked">
        <i style={{ width: `${pct.toFixed(1)}%` }} />
        <span className="mark" style={{ left: `${reserveAt.toFixed(1)}%` }} />
      </div>
      <p className="sub">
        {fill(t.budget.reserveNote, { n: b.reserve })} ·{' '}
        {fill(t.budget.refusedBreakdown, {
          rate: s.limited['cloudflare-1015'] ?? 0,
          challenge: s.limited['cloudflare-challenge'] ?? 0,
          token: s.limited['osuweb'] ?? 0,
        })}
      </p>
    </section>
  );
}

/** Health is judged on head-of-line wait, not depth: a deep queue that drains
 *  fast is fine, a shallow one that never moves is not. Status colour always
 *  ships with an icon and a word so it never rests on colour alone. */
function health(v: { queued: number; oldestWaitMs: number }, t: ReturnType<typeof useI18n>['t']) {
  const w = v.oldestWaitMs / 1000;
  if (!v.queued) return { label: t.levels.idle, icon: '○', cls: 'muted' };
  if (w > 300) return { label: t.levels.stalled, icon: '✕', cls: 'critical' };
  if (w > 60) return { label: t.levels.behind, icon: '▲', cls: 'serious' };
  if (w > 15) return { label: t.levels.busy, icon: '▲', cls: 'warning' };
  return { label: t.levels.keepingUp, icon: '●', cls: 'good' };
}

export function Levels({ s, latency }: { s: Snapshot; latency: Summary['latency'] }) {
  const { t } = useI18n();
  return (
    <section className="card">
      <h2>{t.levels.heading}</h2>
      <div className="scroll">
        <table>
          <colgroup>
            <col style={{ width: '13%' }} /><col style={{ width: '15%' }} />
            <col style={{ width: '8%' }} /><col style={{ width: '13%' }} />
            <col style={{ width: '9%' }} /><col style={{ width: '12%' }} />
            <col style={{ width: '13%' }} /><col style={{ width: '17%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>{t.levels.level}</th><th>{t.levels.health}</th>
              <th className="num">{t.levels.share}</th><th className="num">{t.levels.guaranteed}</th>
              <th className="num">{t.levels.queued}</th><th className="num">{t.levels.oldestWait}</th>
              <th className="num">{t.levels.banked}</th>
              <th className="num" title={t.levels.latencyHint}>{t.levels.latency}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(s.levels).map(([k, v]) => {
              const h = health(v, t);
              const l = latency[k];
              const slow = l?.medTotalMs != null && l.medTotalMs > 30_000;
              return (
                <tr key={k}>
                  <td>{k}</td>
                  <td><span className={`status ${h.cls}`}>{h.icon} {h.label}</span></td>
                  <td className="num">{Math.round(v.share * 100)}%</td>
                  <td className="num">{fill(t.tiles.perMin, { n: v.perMin })}</td>
                  <td className="num">{v.queued}</td>
                  <td className="num">
                    {v.oldestWaitMs ? fill(t.units.seconds, { n: Math.round(v.oldestWaitMs / 1000) }) : '—'}
                  </td>
                  <td className="num">{v.tokens} / {v.capacity}</td>
                  <td className={`num${slow ? ' warning' : ''}`}>
                    {!l || !l.n
                      ? '—'
                      : l.medTotalMs === null
                        ? `${sec(l.avgTotalMs)}s`
                        : `${sec(l.avgTotalMs)}s / ${sec(l.medTotalMs)}s`}
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
  const rank = new Map(data.byConsumer.slice(0, 6).map((r, i) => [r.consumer, colors[i]!]));
  return (
    <section className="card">
      <h2>{t.consumers.heading}</h2>
      <div className="scroll">
        <table>
          <colgroup>
            <col style={{ width: '46%' }} /><col style={{ width: '18%' }} />
            <col style={{ width: '16%' }} /><col style={{ width: '20%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>{t.consumers.consumer}</th><th className="num">{t.consumers.requests}</th>
              <th className="num">{t.consumers.share}</th><th className="num">{t.consumers.avgWait}</th>
            </tr>
          </thead>
          <tbody>
            {data.byConsumer.length === 0 && (
              <tr><td colSpan={4} className="empty">{t.consumers.empty}</td></tr>
            )}
            {data.byConsumer.map((r) => (
              <tr key={r.consumer}>
                <td>
                  {rank.has(r.consumer) && (
                    <i className="swatch" style={{ background: rank.get(r.consumer) }} />
                  )}
                  {r.consumer}
                </td>
                <td className="num">{r.n.toLocaleString()}</td>
                <td className="num">{((r.n / total) * 100).toFixed(1)}%</td>
                <td className="num">{(r.avgWaitMs / 1000).toFixed(2)}s</td>
              </tr>
            ))}
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
            {q.map((r) => {
              const w = r.waitedMs / 1000;
              return (
                <tr key={`${r.position}-${r.path}`}>
                  <td className="num">{r.position}</td>
                  <td>{r.consumer}</td>
                  <td><span className="tag">{r.tier}</span></td>
                  <td className="path" title={r.path}>{r.path}</td>
                  <td className={`num${w > 60 ? ' critical' : w > 15 ? ' warning' : ''}`}>{w.toFixed(1)}s</td>
                </tr>
              );
            })}
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
                <td className={`num${r.limiter ? ' warning' : r.status >= 400 ? ' critical' : ''}`}>
                  {r.limiter ? r.limiter.replace('cloudflare-', 'cf-') : r.status}
                </td>
                <td className="num">{(r.waitedMs / 1000).toFixed(2)}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
