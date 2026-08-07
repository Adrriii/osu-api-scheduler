import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useI18n } from '../i18n/index.js';
import { seriesColors } from '../theme.js';
import type { RequestRow, Snapshot, Summary } from '../types.js';

/**
 * Five priority levels, five lanes. The scheduler happens to have the shape of
 * a mania playfield, so this is the one panel that could not belong to anything
 * but an osu! tool.
 *
 * The field runs two seconds behind reality, and that delay is what makes it
 * honest. Drawing a note at time T, we already hold everything that happened up
 * to T+2, so a request that finishes quickly is animated to land on the line at
 * exactly the moment it really landed -- no guessing, no correction after the
 * fact.
 *
 * A request that outlives the buffer is the interesting case. Nominal speed is
 * one field per second, and past that a note eases back by an amount set by how
 * long its own request is taking, holding off the line for as long as the
 * request really runs and then crossing exactly when it finished. So a slow
 * request looks slow while it is slow, and still lands truthfully.
 */

const W = 220;
const H = 327;
const LANES = ['realtime', 'interactive', 'high', 'normal', 'bulk'];
const LANE_W = W / LANES.length;
const LINE = 270;
const NOTE_H = 13;

/** How far behind reality the field is drawn. The whole design rests on it. */
const DELAY_MS = 2000;
/** A request is expected to take this long: one field per second. */
const NOMINAL_MS = 1000;
/** How long a note takes to be consumed by the line, and its lane to light. */
const HIT_MS = 380;
/**
 * Height above the field a note starts from, so it falls in past the top edge
 * rather than appearing at it. The viewport clips it on the way in, which is
 * what makes it look like it came from somewhere.
 */
const RUNWAY = 46;
/**
 * A request of unknown length settles toward this height, on this time
 * constant. Both exist to keep waiting notes apart: an approach aimed at the
 * line itself crowds them into it, because every extra second buys less and
 * less distance, and a lane of them becomes a stack nobody can count. Aimed at
 * a height short of the line and taken slowly, a note that has waited one
 * second is a clear distance above one that has waited two.
 */
const HOLD = 0.95;
const SETTLE_MS = 4000;

/** Lanes stay a fixed ramp by priority; only the notes carry consumer colour. */
const LANE_COLOURS = ['#ff66ab', '#e35ba8', '#c25aa6', '#9d5cad', '#7c5cd6'];
/** Anyone outside the ranked consumers, who has no colour of their own. */
const UNRANKED = '#4a4655';

const idOf = (r: { tier: string; consumer: string; path: string }) =>
  `${r.tier}|${r.consumer}|${r.path}`;

export type Note = {
  lane: number;
  startedAt: number;
  endedAt: number | null;
  consumer: string;
  path: string;
  /**
   * Highest position drawn so far. A note is never allowed back up the field,
   * whatever the arithmetic says: the clock can be revised, a start can be
   * re-derived when the request finishes, and neither is a reason for a note to
   * climb. Carried across when a waiting note becomes a finished one.
   */
  seen: number;
  /** Field time it first existed, so one that arrives mid-fall fades in. */
  bornAt: number;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Where a note that has no known ending has got to, by age alone.
 *
 * Hyperbolic rather than exponential, because an exponential is spent within a
 * few multiples of its time constant: past about fifteen seconds every waiting
 * note landed on the same pixel and a lane of them became one bar. This keeps
 * giving ground -- twenty seconds of waiting is still visibly above forty, and
 * forty above eighty -- so a backlog reads as a backlog.
 */
const settling = (elapsed: number) => HOLD * (elapsed / (elapsed + SETTLE_MS));

/**
 * Where a note sits, 0 at the top and 1 on the line.
 *
 * Three cases, and which one applies is decided by the request, not by the
 * animation:
 *
 * Inside the nominal second, a request travels at the baseline speed and simply
 * starts its fall earlier, so every quick request falls identically and the
 * field keeps one recognisable rhythm.
 *
 * Beyond it, and while the ending is still unknown, the note settles toward
 * `HOLD` on the `SETTLE_MS` time constant -- slowing from the start and going
 * on slowing, which is what keeps waiting notes a readable distance apart
 * instead of piling into the line.
 *
 * Once the ending is known, and it always is at least two seconds of display
 * time before it is due, the note is brought from wherever it had settled to
 * the line across exactly the time that remains. Position carries over
 * continuously, and the smoothstep means it neither jerks into the catch-up nor
 * slams into the line at the end of it.
 *
 * Exported so the curve can be checked without a browser.
 */
export function progress(n: Note, displayNow: number): number {
  const actual = n.endedAt === null ? null : n.endedAt - n.startedAt;

  // Checked before the guard below, because such a note begins falling before
  // its own request started -- a 0.4s request is on the field for 0.6s before
  // there is anything to wait for.
  if (actual !== null && actual <= NOMINAL_MS) {
    return clamp01((displayNow - (n.endedAt! - NOMINAL_MS)) / NOMINAL_MS);
  }

  const elapsed = displayNow - n.startedAt;
  if (elapsed <= 0) return 0;
  if (n.endedAt === null) return settling(elapsed);
  if (displayNow >= n.endedAt) return 1;

  // The catch-up starts when the answer arrived, or when the note did if the
  // request was shorter than the delay and there was never anything unknown
  // about it.
  const from = Math.max(n.startedAt, n.endedAt - DELAY_MS);
  if (displayNow <= from) return settling(elapsed);

  const held = settling(from - n.startedAt);
  const k = (displayNow - from) / (n.endedAt - from);
  return held + (1 - held) * (k * k * (3 - 2 * k));
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

  // Colour follows the consumer, and it is the same colour the chart and the
  // table give them, so a lane full of one hue is a project you can name
  // without looking anything up. The tier is already said by which lane it is
  // in; coloured by tier as well, the two said the same thing twice.
  const colourOf = useMemo(() => {
    const cols = seriesColors();
    return new Map(byConsumer.slice(0, cols.length).map((r, i) => [r.consumer, cols[i]!]));
  }, [byConsumer]);
  const colour = (c: string) => colourOf.get(c) ?? UNRANKED;

  const notes = useRef(new Map<string, Note>());
  const rects = useRef(new Map<string, SVGRectElement | null>());
  const flashUntil = useRef<number[]>(LANES.map(() => 0));
  const flashColour = useRef<string[]>(LANES.map(() => UNRANKED));
  /** The field's own clock, which only ever moves forward. */
  const lastDisplay = useRef(0);
  const flashes = useRef<(SVGRectElement | null)[]>([]);
  const crossed = useRef(new Set<string>());
  /** Rows already drawn and finished with. The feed keeps 150 of them long
      after the field is done, and re-adding one puts a note back on the page. */
  const done = useRef(new Set<string>());
  /** Browser clock minus server clock, learned from each snapshot. */
  const skew = useRef<number | null>(null);

  /**
   * Two sources, because neither alone is complete. A finished request carries
   * its own history -- it started `waitedMs` before it was recorded -- and that
   * is enough to draw its whole fall, because the field has not got there yet.
   * Anything still queued has no ending to give, so it gets a start and waits
   * for one.
   */
  const drawn = useMemo(() => {
    // Timestamps in the feed come off the server's clock and the browser has
    // its own. Comparing the two directly is what emptied the field: a browser
    // a few seconds fast prunes every note the moment it arrives, and a slow one
    // never reaches the point where a note starts falling. The snapshot carries
    // the server's clock and arrives live, so the offset comes from that -- the
    // newest feed row is only "now" if something happened to have just
    // finished, and on a quiet scheduler that can be minutes ago.
    //
    // Held at the lowest sample seen rather than averaged, with a slow relax
    // upward for genuine drift. A snapshot delayed in transit reads as the
    // server being further behind than it is, and averaging that in drags this
    // clock backwards -- which is a note climbing back up the field, since its
    // height is a function of this clock and nothing else.
    //
    // A server older than this dashboard sends no clock at all, and arithmetic
    // on a missing value yields NaN for every position, which stops the field
    // as dead as any of the above. Missing means trusting the browser.
    if (Number.isFinite(s.now)) {
      const sample = Date.now() - s.now;
      skew.current = skew.current === null ? sample : Math.min(skew.current + 5, sample);
    } else if (skew.current === null) {
      skew.current = 0;
    }
    const now = Date.now() - skew.current;

    // Keyed by the event, not by what was requested: the same consumer asking
    // for the same path again is a second note, not the first one over again.
    for (const r of feed) {
      const key = `f|${r.ts}|${idOf(r)}`;
      if (notes.current.has(key) || done.current.has(key)) continue;
      const lane = LANES.indexOf(r.tier);
      if (lane < 0) continue;

      // Whatever stood in for this request while it waited becomes it, rather
      // than being swapped for a fresh note. The two derive their start from
      // different clocks -- one from the queue as we polled it, one from the
      // record afterwards -- so replacing one with the other moved the note,
      // usually upward. Keeping the original start and how far it had already
      // fallen makes finishing invisible, which is what it should be.
      const pending = `q|${idOf(r)}`;
      const prior = notes.current.get(pending);
      notes.current.delete(pending);
      rects.current.delete(pending);
      crossed.current.delete(pending);

      notes.current.set(key, {
        lane,
        startedAt: prior?.startedAt ?? r.ts - r.waitedMs,
        endedAt: r.ts,
        consumer: r.consumer,
        path: r.path,
        seen: prior?.seen ?? 0,
        bornAt: prior?.bornAt ?? now - DELAY_MS,
      });
    }

    for (const j of s.queue ?? []) {
      const key = `q|${idOf(j)}`;
      if (notes.current.has(key)) continue;
      const lane = LANES.indexOf(j.tier);
      if (lane < 0) continue;
      notes.current.set(key, {
        lane,
        startedAt: now - j.waitedMs,
        endedAt: null,
        consumer: j.consumer,
        path: j.path,
        seen: 0,
        bornAt: now - DELAY_MS,
      });
    }

    // Anything that has crossed and been seen, or that has been falling for
    // longer than the field can meaningfully show, is dropped.
    const display = now - DELAY_MS;
    for (const [key, n] of [...notes.current]) {
      const gone = n.endedAt !== null && display > n.endedAt + HIT_MS + 60;
      const ancient = n.endedAt === null && display - n.startedAt > 600_000;
      if (gone || ancient) {
        notes.current.delete(key);
        rects.current.delete(key);
        crossed.current.delete(key);
        done.current.add(key);
      }
    }

    // Only needs to outlast the feed's own window, and a dashboard left open
    // all day would otherwise accumulate one string per request forever.
    if (done.current.size > 600) {
      for (const k of [...done.current].slice(0, done.current.size - 300)) {
        done.current.delete(k);
      }
    }
    return [...notes.current.entries()];
  }, [s, feed]);

  /**
   * Positions are per-note and not linear, so there is no single transform to
   * move. Attributes are written straight to the elements instead, which keeps
   * a sixty-times-a-second loop out of React entirely.
   */
  const paint = useCallback(() => {
    // Never allowed to run backwards. The offset above is an estimate and an
    // estimate can be revised; a note's height is a function of this clock, so
    // any revision downward would be a note climbing back up the field.
    const raw = Date.now() - (skew.current ?? 0) - DELAY_MS;
    const display = Math.max(raw, lastDisplay.current);
    lastDisplay.current = display;

    for (const [key, n] of notes.current) {
      const el = rects.current.get(key);
      if (!el) continue;
      // Only ever forward. Every remaining way a note could climb -- the clock
      // being revised, a start re-derived on completion, a poll arriving out of
      // order -- ends here rather than being chased individually.
      const p = Math.max(progress(n, display), n.seen);
      n.seen = p;

      // p is time, not height: 0 is the request starting and 1 is it landing on
      // the line. The runway is added to the height only, so where a note is at
      // any moment still means exactly what it did.
      el.setAttribute('y', String(-RUNWAY + p * (LINE - NOTE_H + RUNWAY)));

      // A note is consumed by the line it lands on, rather than sitting on it
      // until a cleanup pass happens to notice. It fades over the same moment
      // the lane lights up, so the two read as one event.
      const past = n.endedAt !== null ? display - n.endedAt : -1;
      const fading = past >= 0 ? Math.max(0, 1 - past / HIT_MS) : 1;
      // A request already part-way through when we first hear of it belongs
      // mid-field, and arriving there abruptly reads as a glitch. It fades in
      // over the same moment instead.
      const arriving = Math.min(1, (display - n.bornAt) / HIT_MS);
      el.setAttribute('opacity', String(Math.min(fading, arriving)));

      // The hit is the note arriving, so it fires off the animation rather
      // than off a message, and lands with the note every time.
      if (p >= 1 && !crossed.current.has(key)) {
        crossed.current.add(key);
        flashUntil.current[n.lane] = Date.now() + HIT_MS;
        flashColour.current[n.lane] = colour(n.consumer);
      }
    }

    flashes.current.forEach((el, lane) => {
      if (!el) return;
      const left = (flashUntil.current[lane] ?? 0) - Date.now();
      el.setAttribute('fill', flashColour.current[lane] ?? UNRANKED);
      el.setAttribute('opacity', left > 0 ? String((left / HIT_MS) * 0.95) : '0');
    });
  }, []);

  // Runs regardless of prefers-reduced-motion. Falling *is* the content here,
  // not decoration on top of it, and someone who turns that setting on to calm
  // interfaces down has not asked for a panel that shows nothing. Stopping the
  // loop after one frame is what left the notes frozen where they mounted.
  useEffect(() => {
    let raf = 0;
    const step = () => {
      paint();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [paint]);

  // New notes have no position until something paints them, and under reduced
  // motion nothing else will.
  useEffect(() => {
    paint();
  }, [drawn, paint]);

  const { served, failed, expired } = s.totals;
  const attempted = served + failed + expired;
  const accuracy = attempted ? (served / attempted) * 100 : 100;

  return (
    <section className="card playfield">
      <h2>{t.playfield.heading}</h2>

      <svg viewBox={`0 0 ${W} ${H}`} className="pf-svg" role="img"
           aria-label={t.playfield.ariaLabel}>
        {LANES.map((tier, i) => (
          <rect key={tier} x={i * LANE_W} y={0} width={LANE_W - 1} height={H}
                className="pf-lane" />
        ))}

        <g>
          {drawn.map(([key, n]) => (
            <rect
              key={key}
              ref={(el) => { rects.current.set(key, el); }}
              x={n.lane * LANE_W + 3}
              y={-NOTE_H}
              width={LANE_W - 7}
              height={NOTE_H}
              rx={3}
              opacity={0}
              fill={colour(n.consumer)}
              className="pf-note"
            >
              <title>{`${n.consumer} · ${n.path}`}</title>
            </rect>
          ))}
        </g>

        {/* Both readouts sit on the field, where osu! puts them: combo through
            the middle of the lanes, accuracy in the top corner. */}
        <text x={W / 2} y={LINE * 0.56} textAnchor="middle" className="pf-combo">
          {s.combo ?? 0}x
        </text>
        <text x={W - 5} y={13} textAnchor="end" className="pf-acc">
          {accuracy.toFixed(2)}%
        </text>

        <line x1={0} x2={W} y1={LINE} y2={LINE} className="pf-line" />

        {LANES.map((tier, i) => (
          <rect key={`f-${tier}`}
                ref={(el) => { flashes.current[i] = el; }}
                x={i * LANE_W + 1} y={LINE - 5}
                width={LANE_W - 3} height={10} rx={3}
                opacity={0}
                fill={UNRANKED} className="pf-hit" />
        ))}

        {LANES.map((tier, i) => (
          <text key={`k-${tier}`} x={i * LANE_W + LANE_W / 2} y={H - 8}
                textAnchor="middle" className="pf-key">
            {tier}
          </text>
        ))}
      </svg>
    </section>
  );
}
