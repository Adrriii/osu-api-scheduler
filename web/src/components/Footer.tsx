import { useI18n, fill } from '../i18n/index.js';
import type { Summary } from '../types.js';

/**
 * Carries the AGPL source offer. The licence requires that people interacting
 * with the software over a network be told where to get it, and a LICENSE file
 * in a repository does not reach someone looking at a dashboard.
 */
export function Footer({ data }: { data: Summary | null }) {
  const { t } = useI18n();
  const source = data?.sourceUrl ?? 'https://github.com/Adrriii/osu-api-scheduler';

  return (
    <footer className="foot">
      <span>{fill(t.footer.name, { version: data?.version ?? '' })}</span>
      <span aria-hidden="true">·</span>
      <span>{t.footer.licence}</span>
      <span aria-hidden="true">·</span>
      <a href={source} target="_blank" rel="noreferrer noopener">{t.footer.source}</a>
      {data?.homeUrl && (
        <>
          <span aria-hidden="true">·</span>
          <a href={data.homeUrl} target="_blank" rel="noreferrer noopener">{data.homeLabel}</a>
        </>
      )}
    </footer>
  );
}
