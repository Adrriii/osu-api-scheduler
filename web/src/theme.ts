/**
 * Categorical slots for the usage chart, in fixed order.
 *
 * The dashboard is dark only, so there is one palette rather than a light and a
 * dark variant. Validated against the card surface (#242229) with the skill's
 * checker: every slot inside the dark lightness band, all above the chroma
 * floor, all at least 3:1 against the surface, worst adjacent pair 12.5 ΔE
 * under protanopia and 21.0 under normal vision.
 *
 * The order is the safety mechanism, not a preference. Orange and green are the
 * classic protanopia confusion and sit deliberately far apart: putting them
 * next to each other drops the worst adjacent pair to 5.4 ΔE, which fails. Slot
 * 1 is osu! pink, darkened from #ff66ab so it lands inside the band.
 *
 * Re-run the validator if you change any of this:
 *   node scripts/validate_palette.js "<hexes>" --mode dark --surface "#242229"
 */
export const SERIES = ['#e05390', '#3a92d8', '#1f9d55', '#8c5cf0', '#c97d00', '#00a2a6'];

export function seriesColors(): string[] {
  return SERIES;
}
