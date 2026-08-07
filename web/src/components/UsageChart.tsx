import { useMemo } from 'react';
import { useI18n, fill } from '../i18n/index.js';
import { seriesColors } from '../theme.js';
import type { Summary } from '../types.js';

const W = 1100;
const H = 260;
const PAD = { l: 48, r: 12, t: 12, b: 28 };

const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Bars rather than a line: these are counts in discrete buckets, not samples of
 * a continuous quantity. Stacked segments carry a 2px gap so adjacent consumers
 * stay separable without relying on hue alone.
 */
export function UsageChart({ data }: { data: Summary }) {
  const { t } = useI18n();
  const colors = seriesColors();

  const model = useMemo(() => {
    const buckets = data.series;
    const totals = new Map<string, number>();
    for (const r of data.seriesByConsumer) {
      totals.set(r.consumer, (totals.get(r.consumer) ?? 0) + r.n);
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, 5).map(([name]) => name);
    // A sixth consumer is never a generated hue: it folds into "Other".
    const names = ranked.length > 5 ? [...top, t.usage.other] : top;

    const at = new Map<number, Map<string, number>>();
    for (const r of data.seriesByConsumer) {
      const key = top.includes(r.consumer) ? r.consumer : t.usage.other;
      if (!at.has(r.t)) at.set(r.t, new Map());
      const m = at.get(r.t)!;
      m.set(key, (m.get(key) ?? 0) + r.n);
    }

    const colorOf = new Map(names.map((n, i) => [n, colors[Math.min(i, colors.length - 1)]!]));
    return { buckets, names, at, colorOf };
  }, [data, colors, t.usage.other]);

  const { buckets, names, at, colorOf } = model;
  if (!buckets.length || !buckets.some((b) => b.n)) {
    return <p className="empty">{t.usage.empty}</p>;
  }

  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const max = Math.max(...buckets.map((b) => b.n), 1);
  const step = iw / buckets.length;
  const bw = Math.max(1, step - 2);
  const ticks = [0, Math.round(max / 2), max];

  const labelIdx = [0, Math.floor(buckets.length / 2), buckets.length - 1];
  const total = buckets.reduce((a, b) => a + b.n, 0);
  const bucketLabel =
    data.bucketMs >= 86_400_000
      ? fill(t.units.days, { n: data.bucketMs / 86_400_000 })
      : data.bucketMs >= 3_600_000
        ? fill(t.units.hours, { n: data.bucketMs / 3_600_000 })
        : fill(t.units.minutes, { n: data.bucketMs / 60_000 });

  return (
    <figure className="figure">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={t.usage.ariaLabel}>
        {ticks.map((v) => {
          const y = PAD.t + ih - (v / max) * ih;
          return (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y} y2={y} className="grid" />
              <text x={PAD.l - 8} y={y + 4} textAnchor="end" className="axis-label">
                {fmt(v)}
              </text>
            </g>
          );
        })}

        {buckets.map((b, i) => {
          const x = PAD.l + i * step;
          const m = at.get(b.t) ?? new Map<string, number>();
          let acc = 0;
          return (
            <g key={b.t}>
              {names.map((name) => {
                const v = m.get(name) ?? 0;
                if (!v) return null;
                const h = (v / max) * ih;
                const y = PAD.t + ih - ((acc + v) / max) * ih;
                acc += v;
                return (
                  <rect
                    key={name}
                    x={x}
                    y={y}
                    width={bw}
                    // 2px surface gap between stacked segments.
                    height={Math.max(0.5, h - 2)}
                    rx={1}
                    fill={colorOf.get(name)}
                  >
                    <title>{`${name}: ${v}`}</title>
                  </rect>
                );
              })}
              {b.n > 0 && (
                <rect x={x} y={PAD.t} width={bw} height={ih} fill="transparent">
                  <title>{`${new Date(b.t).toLocaleString()} — ${b.n}`}</title>
                </rect>
              )}
            </g>
          );
        })}

        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih} y2={PAD.t + ih} className="axis" />
        {labelIdx.map((i) => {
          const b = buckets[i];
          if (!b) return null;
          const d = new Date(b.t);
          const label =
            data.bucketMs >= 7 * 86_400_000
              ? d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
              : data.bucketMs >= 86_400_000
                ? `${d.getMonth() + 1}/${d.getDate()}`
                : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
          const anchor = i === 0 ? 'start' : i === buckets.length - 1 ? 'end' : 'middle';
          return (
            <text
              key={i}
              x={PAD.l + i * step + bw / 2}
              y={H - 8}
              textAnchor={anchor}
              className="axis-label"
            >
              {label}
            </text>
          );
        })}
      </svg>

      <div className="legend">
        {names.map((n) => (
          <span key={n}>
            <i className="swatch" style={{ background: colorOf.get(n) }} />
            {n}
          </span>
        ))}
      </div>
      <figcaption>
        {fill(t.usage.caption, { total: total.toLocaleString(), bucket: bucketLabel })}
      </figcaption>
    </figure>
  );
}
