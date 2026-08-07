import { useState } from 'react';
import { useDashboard } from './api.js';
import { LOCALES, useI18n, type Locale } from './i18n/index.js';
import { UsageChart } from './components/UsageChart.js';
import { Budget, Consumers, Feed, Levels, QueuePanel, Tiles } from './components/Panels.js';
import { Footer } from './components/Footer.js';

type Range = 'hour' | 'day' | 'month' | 'year';

export function App() {
  const { t, locale, setLocale } = useI18n();
  const [range, setRange] = useState<Range>('hour');
  const { summary, snapshot, feed, connected, error } = useDashboard(range);

  const ranges: [Range, string][] = [
    ['hour', t.usage.hour],
    ['day', t.usage.day],
    ['month', t.usage.month],
    ['year', t.usage.year],
  ];

  return (
    <div className="wrap">
      <header>
        <h1>{t.title}</h1>
        <span className="sub">
          <span className={`dot${connected ? '' : ' stale'}`} />{' '}
          {connected ? t.live : t.reconnecting}
        </span>
        <span className="spacer" />
        <select
          className="lang"
          value={locale}
          aria-label="Language"
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          {Object.entries(LOCALES).map(([code, l]) => (
            <option key={code} value={code}>{l.label}</option>
          ))}
        </select>
        <a className="sub" href="/auth/logout">{t.signOut}</a>
      </header>

      {error && <p className="card critical">{t.error.load}</p>}

      {summary && <Tiles data={summary} />}
      {snapshot && <Budget s={snapshot} />}
      {snapshot && summary && <Levels s={snapshot} latency={summary.latency} />}

      <section className="card">
        <div className="row">
          <h2 className="flush">{t.usage.heading}</h2>
          <span className="spacer" />
          {ranges.map(([key, label]) => (
            <button
              key={key}
              className="range"
              aria-pressed={range === key}
              onClick={() => setRange(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {summary && <UsageChart data={summary} />}
      </section>

      {summary && <Consumers data={summary} />}
      {snapshot && <QueuePanel s={snapshot} />}
      <Feed rows={feed} />
      <Footer data={summary} />
    </div>
  );
}
