import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.js';
import { seriesColors } from '../theme.js';
import type { RequestRow, Snapshot, Summary } from '../types.js';

/**
 * One lane per priority level. A note is one request, falling from when it was
 * queued to when it was sent.
 *
 * Everything here follows from one decision: the field is drawn two seconds
 * behind real time. At any moment it is showing T while we already hold
 * everything that happened up to T+2, so we are never guessing about the next
 * two seconds of a note's life.
 *
 *   - A request that took a second or less is entirely in the past by the time
 *     the field reaches it. It falls the whole way at the base speed, one field
 *     per second, and lands on the line at the moment it really landed.
 *
 *   - A slower one is still running when the field reaches it. Its note falls
 *     at the base speed and then eases off, covering half the field in the
 *     first second and halving what remains again and again -- never arriving,
 *     because arriving would be a claim we cannot make.
 *
 *   - Two seconds before it is due, the ending is known, and the note is walked
 *     from wherever it had got to onto the line, arriving exactly on time.
 *
 * A note therefore never moves except toward the line, and lands when its
 * request did. Both facts are the point.
 */

/**
 * The field's own units. Width is fixed and height follows the space it is
 * given, so it fills its panel exactly instead of setting its own height from
 * its width and forcing everything beside it to match.
 */
const W = 220;
const LANES = ['realtime', 'interactive', 'high', 'normal'];
const LANE_W = W / LANES.length;
/** Room under the line for the lane names. */
const FOOT = 40;
const NOTE_H = 12;

/** How far behind real time the field is drawn. Everything rests on this. */
const DELAY_MS = 2000;
/** The base speed: a request of this length falls one whole field. */
const NOMINAL_MS = 1000;
/** Started above the top edge, so notes fall in rather than appear. */
const RUNWAY = 40;
/** How long a landed note takes to be consumed, and its lane to light up. */
const HIT_MS = 300;

const LANE_COLOURS = ['#ff66ab', '#e0589f', '#b95ea8', '#8c5cd0'];
/** Consumers outside the ranked ones, who have no colour of their own. */
const UNRANKED = '#4a4655';

type Note = {
  lane: number;
  startedAt: number;
  endedAt: number | null;
  consumer: string;
  path: string;
};

/**
 * How far down the field, 0 at the top and 1 on the line, at field time `at`.
 *
 * Exported so the shape can be checked without a browser.
 */
export function progress(n: Note, at: number): number {
  const done = n.endedAt !== null;
  const took = done ? n.endedAt! - n.startedAt : 0;

  // Nothing quicker than the base speed. A request faster than a second starts
  // its fall late rather than falling faster, so every quick note moves at the
  // same rate and the field keeps one readable rhythm.
  if (done && took <= NOMINAL_MS) {
    return clamp01((at - (n.endedAt! - NOMINAL_MS)) / NOMINAL_MS);
  }

  const age = at - n.startedAt;
  if (age <= 0) return 0;

  // Half the field in the first second, then half of what is left each second
  // after. Starts at exactly the base speed and slows from there, which is what
  // keeps a queue of waiting notes spread out instead of piled on the line.
  const easing = age / (age + NOMINAL_MS);

  if (!done) return easing;
  if (at >= n.endedAt!) return 1;

  // The ending is known: walk it in from wherever it had got to. The window is
  // the two seconds we are behind by, or the note's whole life if it was
  // shorter than that and there was never anything unknown about it.
  const from = Math.max(n.startedAt, n.endedAt! - DELAY_MS);
  if (at <= from) return easing;

  const held = (from - n.startedAt) / (from - n.startedAt + NOMINAL_MS);
  const k = (at - from) / (n.endedAt! - from);
  return held + (1 - held) * (k * k * (3 - 2 * k));
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const failed = (r: RequestRow) => !!r.limiter || r.status >= 400 || r.status === 0;

/**
 * The combo as the field sees it, rather than as the server does.
 *
 * The scheduler's count is of right now; the field is showing two seconds ago,
 * so reading it directly made the number rise two seconds before the note that
 * earned it reached the line. Here the rows after the field's clock are ignored
 * and the streak is counted back from it, so it rises exactly as a note lands.
 *
 * Rows only reach back 150, so a longer streak cannot be counted from them.
 * Where no break is found within that window the server's total stands in,
 * less what has landed since -- but only back to `countedAt`, the moment that
 * total was taken. Subtracting rows the server had not yet seen made the number
 * fall by one for every request that arrived between snapshots, which is a
 * combo going *down* on a hit.
 *
 * Exported so it can be checked without a browser.
 */
export function comboAt(
  feed: RequestRow[],
  at: number,
  serverCombo: number,
  countedAt: number,
): number {
  let streak = 0;
  let sinceField = 0;
  let brokeSinceField = false;

  for (const r of feed) {
    if (r.ts > at) {
      // Only what the server's own total already accounts for.
      if (r.ts <= countedAt) {
        if (failed(r)) brokeSinceField = true;
        else sinceField++;
      }
      continue;
    }
    if (failed(r)) return streak;
    streak++;
  }

  // Nothing in the window broke it, so it runs back further than we can see.
  if (!brokeSinceField) return Math.max(streak, serverCombo - sinceField);
  return streak;
}

/**
 * One step of the field's clock.
 *
 * It advances at wall speed and is nudged toward `target` by at most a tenth of
 * the elapsed time, so it cannot jump and cannot run backwards. Reading the
 * target directly is what made the field lurch: the offset it is built from is
 * re-estimated on every snapshot, and each correction, however small, moved
 * every note at once.
 *
 * Exported so the discipline can be checked without a browser.
 */
export function stepClock(prev: number, lastWall: number, wall: number, target: number): number {
  if (!prev) return target;
  const dt = Math.max(0, Math.min(250, wall - lastWall));
  const drift = target - (prev + dt);
  return prev + dt + Math.max(-dt * 0.1, Math.min(dt * 0.1, drift));
}

export function Playfield({
  s,
  feed,
  byConsumer,
}: {
  s: Snapshot;
  feed: RequestRow[];
  byConsumer: Summary['byConsumer'];
}) {
  const { t } = useI18n();

  // The colour a consumer already has in the chart and the table, so a lane
  // full of one hue is a project you can name without looking it up.
  const colourOf = useMemo(() => {
    const cols = seriesColors();
    return new Map(byConsumer.slice(0, cols.length).map((r, i) => [r.consumer, cols[i]!]));
  }, [byConsumer]);
  const colour = (c: string) => colourOf.get(c) ?? UNRANKED;

  const notes = useRef(new Map<number, Note>());
  const rects = useRef(new Map<number, SVGRectElement | null>());
  const flashes = useRef<(SVGRectElement | null)[]>([]);
  const flashUntil = useRef<number[]>(LANES.map(() => 0));
  const landed = useRef(new Set<number>());
  /** Read by the frame loop, which must not close over a changing prop. */
  const rows = useRef<RequestRow[]>(feed);
  const serverCombo = useRef(0);
  /** Server time the count above was taken at. */
  const comboAsOf = useRef(0);
  const comboText = useRef<SVGTextElement | null>(null);

  /**
   * Browser clock minus the server's.
   *
   * Held at the lowest sample seen, with a small allowance to rise for genuine
   * drift. A snapshot delayed in transit arrives looking like the server is
   * further behind than it is, and taking each sample at face value moved this
   * estimate -- and therefore every note on the field -- several times a second.
   * The lowest sample is the one that spent least time in transit, so it is the
   * closest to the truth.
   */
  const skew = useRef<number | null>(null);

  // Height in the field's units, taken from the shape of the panel it is in.
  const box = useRef<HTMLDivElement | null>(null);
  const [vh, setVh] = useState(327);
  const line = Math.max(80, vh - FOOT);
  const lineRef = useRef(line);
  lineRef.current = line;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setVh(Math.round((W * height) / width));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** The field's own clock, and the wall time it was last advanced at. */
  const clock = useRef(0);
  const lastWall = useRef(0);

  /**
   * The time the field is showing.
   *
   * It runs at wall speed and is only ever nudged toward where the estimate says
   * it should be, by at most a tenth of the elapsed time. Reading the estimate
   * directly is what made the field jump: every correction to it, however small,
   * moved every note at once, several times a second. Slewing means the clock
   * cannot jump and cannot run backwards, so a note's position is a function of
   * something that only ever advances smoothly.
   */
  const fieldNow = () => {
    const wall = Date.now();
    clock.current = stepClock(
      clock.current,
      lastWall.current,
      wall,
      wall - (skew.current ?? 0) - DELAY_MS,
    );
    lastWall.current = wall;
    return clock.current;
  };

  /**
   * Both views of a request now carry its id and the moment it was queued, so a
   * job seen waiting and the record of it finishing are recognisably the same
   * note. It is created once, updated in place, and removed when it has landed
   * and faded. Nothing is ever rebuilt under a new identity.
   */
  const ids = useMemo(() => {
    if (Number.isFinite(s.now)) {
      const sample = Date.now() - s.now;
      skew.current = skew.current === null ? sample : Math.min(skew.current + 20, sample);
    }
    const at = fieldNow();
    rows.current = feed;
    serverCombo.current = s.combo ?? 0;
    comboAsOf.current = Number.isFinite(s.now) ? s.now : Date.now();

    for (const j of s.queue ?? []) {
      const lane = LANES.indexOf(j.tier);
      if (lane >= 0 && !notes.current.has(j.id)) {
        notes.current.set(j.id, {
          lane,
          startedAt: j.startedAt,
          endedAt: null,
          consumer: j.consumer,
          path: j.path,
        });
      }
    }

    for (const r of feed) {
      const lane = LANES.indexOf(r.tier);
      if (lane < 0 || landed.current.has(r.id)) continue;
      const existing = notes.current.get(r.id);
      if (existing) existing.endedAt = r.ts;
      else {
        notes.current.set(r.id, {
          lane,
          startedAt: r.startedAt,
          endedAt: r.ts,
          consumer: r.consumer,
          path: r.path,
        });
      }
    }

    for (const [id, n] of [...notes.current]) {
      const spent = n.endedAt !== null && at > n.endedAt + HIT_MS;
      // A request nobody ever told us finished. Rare, but a note that cannot
      // land must not haunt the field forever either.
      const stale = n.endedAt === null && at - n.startedAt > 900_000;
      if (spent || stale) {
        notes.current.delete(id);
        rects.current.delete(id);
        landed.current.add(id);
      }
    }

    // Only needs to outlast the feed's own window of 150 rows.
    if (landed.current.size > 600) {
      for (const k of [...landed.current].slice(0, 300)) landed.current.delete(k);
    }

    return [...notes.current.keys()];
  }, [s, feed]);

  /**
   * Positions are per note and not linear, so each one is written straight to
   * its element. That keeps a sixty-times-a-second loop out of React.
   */
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const wall = Date.now();
      const at = fieldNow();

      for (const [id, n] of notes.current) {
        const el = rects.current.get(id);
        if (!el) continue;

        const p = progress(n, at);
        el.setAttribute('y', String(-RUNWAY + p * (lineRef.current - NOTE_H + RUNWAY)));

        // Consumed by the line it lands on, over the same moment its lane
        // lights up, so the two read as one event.
        const past = n.endedAt !== null ? at - n.endedAt : -1;
        el.setAttribute('opacity', past >= 0 ? String(Math.max(0, 1 - past / HIT_MS)) : '1');

        if (p >= 1 && !landed.current.has(id)) {
          landed.current.add(id);
          flashUntil.current[n.lane] = wall + HIT_MS;
        }
      }

      // Written here rather than rendered, so it changes on the frame the note
      // lands rather than whenever React next has a reason to run.
      if (comboText.current) {
        comboText.current.textContent =
          `${comboAt(rows.current, at, serverCombo.current, comboAsOf.current)}x`;
      }

      flashes.current.forEach((el, lane) => {
        if (!el) return;
        const left = (flashUntil.current[lane] ?? 0) - wall;
        el.setAttribute('opacity', left > 0 ? String(left / HIT_MS) : '0');
      });

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  const { served, failed, expired } = s.totals;
  const attempted = served + failed + expired;
  const accuracy = attempted ? (served / attempted) * 100 : 100;

  return (
    <section className="card playfield" ref={box}>
      <svg viewBox={`0 0 ${W} ${vh}`} preserveAspectRatio="none"
           className="pf-svg" role="img"
           aria-label={t.playfield.ariaLabel}>
        {LANES.map((tier, i) => (
          <rect key={tier} x={i * LANE_W} y={0} width={LANE_W - 1} height={vh}
                className="pf-lane" />
        ))}

        <defs>
          <clipPath id="pf-clip">
            <rect x={0} y={0} width={W} height={line} />
          </clipPath>
          {/* Light off the line, brightest where the note met it. Not a colour:
              every lane lights the same way, so the flash says a request went
              rather than repeating who sent it. */}
          <linearGradient id="pf-light" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.9" />
            <stop offset="45%" stopColor="#fff" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>

        <g clipPath="url(#pf-clip)">
          {ids.map((id) => {
            const n = notes.current.get(id)!;
            return (
              <rect
                key={id}
                ref={(el) => { rects.current.set(id, el); }}
                x={n.lane * LANE_W + 3}
                y={-RUNWAY}
                width={LANE_W - 7}
                height={NOTE_H}
                rx={3}
                fill={colour(n.consumer)}
                className="pf-note"
              >
                <title>{`${n.consumer} · ${n.path}`}</title>
              </rect>
            );
          })}
        </g>

        <text ref={comboText} x={W / 2} y={line * 0.56} textAnchor="middle"
              className="pf-combo">
          0x
        </text>
        <text x={W - 5} y={13} textAnchor="end" className="pf-acc">
          {accuracy.toFixed(2)}%
        </text>

        <line x1={0} x2={W} y1={line} y2={line} className="pf-line" />

        {LANES.map((tier, i) => (
          <rect key={`f-${tier}`}
                ref={(el) => { flashes.current[i] = el; }}
                x={i * LANE_W} y={line - 34}
                width={LANE_W - 1} height={34}
                opacity={0} fill="url(#pf-light)" className="pf-hit" />
        ))}

        {LANES.map((tier, i) => (
          <text key={`k-${tier}`} x={i * LANE_W + LANE_W / 2} y={vh - 8}
                textAnchor="middle" className="pf-key">
            {tier}
          </text>
        ))}
      </svg>
    </section>
  );
}
