import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.js';
import type { RequestRow, Snapshot } from '../types.js';

/**
 * Five priority levels, five lanes. The scheduler happens to have exactly the
 * shape of a mania playfield, so this is the one widget that could not belong
 * to anything but an osu! tool.
 *
 * It is for watching, not for reading: the tables above give the numbers. What
 * it shows at a glance is movement -- a lane whose notes keep arriving at the
 * line is being served, and one whose notes sit still is not. That is the
 * failure this whole service exists to prevent, and it is the one thing a
 * column of numbers is bad at showing.
 *
 * Nothing here is decorative. Every note is a request that is really queued,
 * every hit is a request that was really sent.
 */

const W = 220;
const H = 430;
const LANES = ['realtime', 'interactive', 'high', 'normal', 'bulk'];
const LANE_W = W / LANES.length;
const LINE = 356;
const NOTE_H = 13;
const GAP = 30;

/**
 * Sequential by priority rather than categorical: the lanes are ordered, and
 * osu! pink belongs to the level that cannot wait. Deliberately not the chart's
 * palette, which identifies consumers -- reusing it here would imply the two
 * meant the same thing.
 */
const LANE_COLOURS = ['#ff66ab', '#e35ba8', '#c25aa6', '#9d5cad', '#7c5cd6'];

export function Playfield({ s, feed }: { s: Snapshot; feed: RequestRow[] }) {
  const { t } = useI18n();

  // A hit is drawn when a request actually leaves, so the flashes are dispatch
  // events rather than an animation loop running on its own.
  const [hits, setHits] = useState<{ id: number; lane: number }[]>([]);
  const seen = useRef<number>(0);
  const nextId = useRef(0);

  useEffect(() => {
    const newest = feed[0];
    if (!newest || newest.ts <= seen.current) return;

    // The feed arrives backfilled, so the first batch is history rather than
    // things happening now. Take note of where it ends and only flash what
    // arrives after: otherwise the panel opens by firing every row at once.
    if (seen.current === 0) {
      seen.current = newest.ts;
      return;
    }

    const fresh = feed.filter((r) => r.ts > seen.current);
    seen.current = newest.ts;

    const added = fresh
      .map((r) => ({ id: nextId.current++, lane: LANES.indexOf(r.tier) }))
      .filter((x) => x.lane >= 0);
    if (!added.length) return;

    setHits((h) => [...h, ...added].slice(-24));
    const timer = setTimeout(
      () => setHits((h) => h.filter((x) => !added.some((a) => a.id === x.id))),
      520,
    );
    return () => clearTimeout(timer);
  }, [feed]);

  // Notes are laid out per lane rather than by global queue position, so each
  // lane reads as its own backlog and a note gliding down means the one ahead
  // of it was served.
  const byLane = LANES.map((tier) =>
    (s.queue ?? []).filter((j) => j.tier === tier).sort((a, b) => a.position - b.position),
  );

  const { served, failed, expired } = s.totals;
  const attempted = served + failed + expired;
  const accuracy = attempted ? (served / attempted) * 100 : 100;

  // Consecutive delivered requests, newest first, broken by a refusal or an
  // error. A break is exactly the moment osu! turned us away.
  let combo = 0;
  for (const r of feed) {
    if (r.limiter || r.status >= 400 || r.status === 0) break;
    combo++;
  }

  return (
    <section className="card playfield">
      <h2>{t.playfield.heading}</h2>

      <div className="pf-hud">
        <span className="pf-acc tabular">{accuracy.toFixed(2)}%</span>
        <span className="spacer" />
        <span className="pf-combo tabular">{combo}x</span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="pf-svg" role="img"
           aria-label={t.playfield.ariaLabel}>
        {LANES.map((tier, i) => (
          <rect key={tier} x={i * LANE_W} y={0} width={LANE_W - 1} height={H}
                className="pf-lane" />
        ))}

        {/* The judgement line. Notes below it have already gone. */}
        <line x1={0} x2={W} y1={LINE} y2={LINE} className="pf-line" />

        {byLane.map((jobs, lane) =>
          jobs.map((job, i) => {
            const y = LINE - (i + 1) * GAP;
            if (y < -NOTE_H) return null;
            return (
              <rect
                key={`${job.position}-${job.path}`}
                x={lane * LANE_W + 3}
                y={y}
                width={LANE_W - 7}
                height={NOTE_H}
                rx={3}
                fill={LANE_COLOURS[lane]}
                className="pf-note"
              >
                <title>{`${job.consumer} · ${job.path}`}</title>
              </rect>
            );
          }),
        )}

        {hits.map((h) => (
          <rect key={h.id} x={h.lane * LANE_W + 1} y={LINE - 5}
                width={LANE_W - 3} height={10} rx={3}
                fill={LANE_COLOURS[h.lane]} className="pf-hit" />
        ))}

        {LANES.map((tier, i) => (
          <text key={tier} x={i * LANE_W + LANE_W / 2} y={H - 8}
                textAnchor="middle" className="pf-key">
            {tier.slice(0, 2).toUpperCase()}
          </text>
        ))}
      </svg>
    </section>
  );
}
