import { useEffect, useMemo, useRef } from 'react';
import { useI18n } from '../i18n/index.js';
import type { RequestRow, Snapshot } from '../types.js';

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

const LANE_COLOURS = ['#ff66ab', '#e35ba8', '#c25aa6', '#9d5cad', '#7c5cd6'];

const idOf = (r: { tier: string; consumer: string; path: string }) =>
  `${r.tier}|${r.consumer}|${r.path}`;

export type Note = {
  lane: number;
  startedAt: number;
  endedAt: number | null;
  consumer: string;
  path: string;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Where a note sits, 0 at the top and 1 on the line.
 *
 * One curve covers every case, shaped by how long the request itself takes:
 *
 *   p = 1 - (1 - x)^r,  x = elapsed / duration,  r = 1 + ln(duration / 1s)
 *
 * At a one-second request r is 1 and that is a straight line, which is why it
 * meets the constant-speed case below without a seam. Longer requests bend
 * further, so a note falls freely at first and then holds off the line for as
 * long as its request really runs.
 *
 * While a request is still in flight its duration is unknown, but not
 * unbounded: the field is drawn two seconds in the past, and the request had
 * not finished as of the newest thing we hold, so it has already lasted at
 * least `elapsed + 2s`. Feeding that lower bound to the same curve keeps a note
 * off the line without capping it anywhere, and because the bound grows exactly
 * as fast as the delay is long, it *equals* the real duration at the instant
 * the ending arrives. The curve therefore never steps when the answer lands --
 * there is no catch-up phase, because there is nothing to catch up.
 *
 * Exported so the curve can be checked without a browser.
 */
export function progress(n: Note, displayNow: number): number {
  const actual = n.endedAt === null ? null : n.endedAt - n.startedAt;

  // Anything inside the nominal second travels at the baseline speed and simply
  // starts its fall earlier, so every quick request falls identically and the
  // field has one recognisable rhythm. Checked before the guard below, because
  // such a note begins falling before its own request started -- a 0.4s request
  // is on the field for 0.6s before there is anything to wait for.
  if (actual !== null && actual <= NOMINAL_MS) {
    return clamp01((displayNow - (n.endedAt! - NOMINAL_MS)) / NOMINAL_MS);
  }

  const elapsed = displayNow - n.startedAt;
  if (elapsed <= 0) return 0;

  const d = actual ?? Math.max(NOMINAL_MS, elapsed + DELAY_MS);
  const x = clamp01(elapsed / d);
  const r = 1 + Math.log(d / NOMINAL_MS);
  return 1 - Math.pow(1 - x, r);
}

export function Playfield({ s, feed }: { s: Snapshot; feed: RequestRow[] }) {
  const { t } = useI18n();

  const notes = useRef(new Map<string, Note>());
  const rects = useRef(new Map<string, SVGRectElement | null>());
  const flashUntil = useRef<number[]>(LANES.map(() => 0));
  const flashes = useRef<(SVGRectElement | null)[]>([]);
  const crossed = useRef(new Set<string>());
  /** Browser clock minus server clock, learned from the feed. */
  const skew = useRef<number | null>(null);
  const newestSeen = useRef(0);

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
    // never reaches the point where a note starts falling.
    //
    // A row only says "just now" at the moment it first appears, so that is the
    // only time it is sampled.
    const newestTs = feed[0]?.ts ?? 0;
    if (newestTs > newestSeen.current) {
      const sample = Date.now() - newestTs;
      skew.current = skew.current === null ? sample : skew.current + (sample - skew.current) * 0.2;
      newestSeen.current = newestTs;
    }
    const now = Date.now() - (skew.current ?? 0);

    // Keyed by the event, not by what was requested: the same consumer asking
    // for the same path again is a second note, not the first one over again.
    for (const r of feed) {
      const key = `f|${r.ts}|${idOf(r)}`;
      if (notes.current.has(key)) continue;
      const lane = LANES.indexOf(r.tier);
      if (lane < 0) continue;

      // It finished, so whatever was standing in for it while it waited is done.
      const pending = `q|${idOf(r)}`;
      notes.current.delete(pending);
      rects.current.delete(pending);
      crossed.current.delete(pending);

      notes.current.set(key, {
        lane,
        startedAt: r.ts - r.waitedMs,
        endedAt: r.ts,
        consumer: r.consumer,
        path: r.path,
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
      });
    }

    // Anything that has crossed and been seen, or that has been falling for
    // longer than the field can meaningfully show, is dropped.
    const display = now - DELAY_MS;
    for (const [key, n] of [...notes.current]) {
      const gone = n.endedAt !== null && display > n.endedAt + 600;
      const ancient = n.endedAt === null && display - n.startedAt > 600_000;
      if (gone || ancient) {
        notes.current.delete(key);
        rects.current.delete(key);
        crossed.current.delete(key);
      }
    }
    return [...notes.current.entries()];
  }, [s, feed]);

  /**
   * Positions are per-note and not linear, so there is no single transform to
   * move. Attributes are written straight to the elements instead, which keeps
   * a sixty-times-a-second loop out of React entirely.
   */
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    const step = () => {
      const display = Date.now() - (skew.current ?? 0) - DELAY_MS;

      for (const [key, n] of notes.current) {
        const el = rects.current.get(key);
        if (!el) continue;
        const p = progress(n, display);
        el.setAttribute('y', String(p * (LINE - NOTE_H)));
        el.setAttribute('opacity', p > 0 ? '1' : '0');

        // The hit is the note arriving, so it fires off the animation rather
        // than off a message, and lands with the note every time.
        if (p >= 1 && !crossed.current.has(key)) {
          crossed.current.add(key);
          flashUntil.current[n.lane] = Date.now() + 520;
        }
      }

      flashes.current.forEach((el, lane) => {
        if (!el) return;
        const left = (flashUntil.current[lane] ?? 0) - Date.now();
        el.setAttribute('opacity', left > 0 ? String((left / 520) * 0.95) : '0');
      });

      if (!reduced) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  const { served, failed, expired } = s.totals;
  const attempted = served + failed + expired;
  const accuracy = attempted ? (served / attempted) * 100 : 100;

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
              fill={LANE_COLOURS[n.lane]}
              className="pf-note"
            >
              <title>{`${n.consumer} · ${n.path}`}</title>
            </rect>
          ))}
        </g>

        <line x1={0} x2={W} y1={LINE} y2={LINE} className="pf-line" />

        {LANES.map((tier, i) => (
          <rect key={`f-${tier}`}
                ref={(el) => { flashes.current[i] = el; }}
                x={i * LANE_W + 1} y={LINE - 5}
                width={LANE_W - 3} height={10} rx={3}
                opacity={0}
                fill={LANE_COLOURS[i]} className="pf-hit" />
        ))}

        {LANES.map((tier, i) => (
          <text key={`k-${tier}`} x={i * LANE_W + LANE_W / 2} y={H - 8}
                textAnchor="middle" className="pf-key">
            {tier.slice(0, 2).toUpperCase()}
          </text>
        ))}
      </svg>
    </section>
  );
}
