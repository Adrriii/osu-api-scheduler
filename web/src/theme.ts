/**
 * Categorical slots from a palette validated for colour-vision deficiency in
 * both light and dark: worst adjacent CVD separation 9.1 light / 8.4 dark on
 * the default adjacent pairlist, comfortably over the 8 target. The ordering is
 * the safety mechanism, so do not reorder these to taste -- re-run the
 * validator if you change them.
 *
 * Three light-mode slots sit below 3:1 against the surface, which is why the
 * chart always ships a legend and a table view rather than relying on colour.
 */
export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];

export function seriesColors(): string[] {
  const dark =
    document.documentElement.dataset.theme === 'dark' ||
    (document.documentElement.dataset.theme !== 'light' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? SERIES_DARK : SERIES_LIGHT;
}
