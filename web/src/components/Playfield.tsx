import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.js';
import type { RequestRow, Snapshot } from '../types.js';

/**
 * Five priority levels, five lanes. The scheduler happens to have the shape of
 * a mania playfield, so this is the one panel that could not belong to anything
 * but an osu! tool.
 *
 * It is for watching, not for reading -- the tables have the numbers. What it
 * shows is movement: a lane whose notes keep reaching the line is being served,
 * and one whose notes pile up on it is not. That is the failure this service
 * exists to prevent, and a column of numbers is bad at showing it.
 *
 * Height is time. A note's distance from the line is how long until that
 * request is due to be sent, so the field scrolls at a constant rate and a note
 * lands on the line at the moment it is expected to go. That is what makes it
 * gameplay rather than a queue drawn vertically: nothing is placed by its index
 * and nothing jumps when the queue shifts. A note keeps the arrival time it was
 * given and scrolls to meet it.
 */

const W = 220;
const H = 327;
const LANES = ['realtime', 'interactive', 'high', 'normal', 'bulk'];
const LANE_W = W / LANES.length;
const LINE = 270;
const NOTE_H = 13;

/** Seconds of runway visible above the line. Sets the scroll speed. */
const LOOKAHEAD_MS = 15_000;
const SPEED = LINE / LOOKAHEAD_MS; // px per ms

/**
 * Sequential by priority rather than categorical: the lanes are ordered, and
 * osu! pink belongs to the level that cannot wait. Deliberately not the chart's
 * palette, which identifies consumers -- reusing it here would imply the two
 * meant the same thing.
 */
const LANE_COLOURS = ['#ff66ab', '#e35ba8', '#c25aa6', '#9d5cad', '#7c5cd6'];

/** The queue carries no id, so identity is what the request actually is. */
const idOf = (j: { tier: string; consumer: string; path: string }) =>
  `${j.tier}|${j.consumer}|${j.path}`;

export type Note = { lane: number; eta: number; consumer: string; path: string };

/**
 * Give every queued request the time it is due to be sent, and keep it.
 *
 * Handing out arrival times once and never revising them is what makes this
 * gameplay rather than a queue drawn vertically. Revising on every poll is what
 * made notes jump: a job one place further up would be re-placed a step lower
 * each time the queue moved. Keeping the time means the note carries on falling
 * toward it, and the one in front being served changes nothing behind it.
 *
 * Exported so the timing can be tested without a browser.
 */
export function schedule(
  notes: Map<string, Note>,
  queue: Snapshot['queue'],
  levels: Snapshot['levels'],
  now: number,
): Map<string, Note> {
  const live = new Set((queue ?? []).map(idOf));
  for (const key of [...notes.keys()]) {
    if (!live.has(key)) notes.delete(key);
  }

  // New arrivals go behind whatever that lane already holds, spaced by how
  // often the level actually gets to send. A slow lane's notes are far apart
  // because its requests really are further away.
  const backOf = new Map<number, number>();
  for (const n of notes.values()) {
    backOf.set(n.lane, Math.max(backOf.get(n.lane) ?? 0, n.eta));
  }

  for (const job of queue ?? []) {
    const key = idOf(job);
    if (notes.has(key)) continue;
    const lane = LANES.indexOf(job.tier);
    if (lane < 0) continue;

    const perMin = levels[job.tier]?.perMin ?? 1;
    const gap = 60_000 / Math.max(1, perMin);
    const eta = Math.max(now, backOf.get(lane) ?? 0) + gap;
    backOf.set(lane, eta);
    notes.set(key, { lane, eta, consumer: job.consumer, path: job.path });
  }
  return notes;
}

export function Playfield({ s, feed }: { s: Snapshot; feed: RequestRow[] }) {
  const { t } = useI18n();
  const scroller = useRef<SVGGElement | null>(null);
  const notes = useRef(new Map<string, Note>());

  const { placed, tref } = useMemo(() => {
    const now = Date.now();
    schedule(notes.current, s.queue, s.levels, now);
    return { placed: [...notes.current.values()], tref: now };
  }, [s]);

  /**
   * One transform for the whole field, moved on every frame. Every note travels
   * at the same speed, so scrolling is a single mutation rather than a React
   * render per frame.
   */
  useEffect(() => {
    const g = scroller.current;
    // Scrolling is the whole idea, so when motion is unwelcome the field still
    // shows where everything is, just without moving to get there.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      g?.setAttribute('transform', 'translate(0 0)');
      return;
    }
    let raf = 0;
    const step = () => {
      if (scroller.current) {
        scroller.current.setAttribute(
          'transform',
          `translate(0 ${(Date.now() - tref) * SPEED})`,
        );
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [tref]);

  // A note whose time has come but which is still queued rests on the line
  // instead of falling through it. A lane wearing a stack of them is stuck.
  const due = placed.filter((n) => n.eta <= tref);
  const falling = placed.filter((n) => n.eta > tref && n.eta - tref < LOOKAHEAD_MS * 1.4);

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
        <defs>
          {/* Notes appear at the top edge rather than popping into being. */}
          <clipPath id="pf-clip">
            <rect x={0} y={0} width={W} height={LINE + 2} />
          </clipPath>
        </defs>

        {LANES.map((tier, i) => (
          <rect key={tier} x={i * LANE_W} y={0} width={LANE_W - 1} height={H}
                className="pf-lane" />
        ))}

        <g clipPath="url(#pf-clip)">
          <g ref={scroller}>
            {falling.map((n) => (
              <rect
                key={`${n.lane}-${n.path}-${n.eta}`}
                x={n.lane * LANE_W + 3}
                y={LINE - (n.eta - tref) * SPEED - NOTE_H}
                width={LANE_W - 7}
                height={NOTE_H}
                rx={3}
                fill={LANE_COLOURS[n.lane]}
                className="pf-note"
              >
                <title>{`${n.consumer} · ${n.path}`}</title>
              </rect>
            ))}
          </g>

          {/* Overdue notes are pinned, so they do not scroll away from the line
              they never got hit on. */}
          {due.map((n, i) => (
            <rect
              key={`due-${n.lane}-${n.path}`}
              x={n.lane * LANE_W + 3}
              y={LINE - NOTE_H - i * 2}
              width={LANE_W - 7}
              height={NOTE_H}
              rx={3}
              fill={LANE_COLOURS[n.lane]}
              className="pf-note pf-due"
            >
              <title>{`${n.consumer} · ${n.path}`}</title>
            </rect>
          ))}
        </g>

        <line x1={0} x2={W} y1={LINE} y2={LINE} className="pf-line" />

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
