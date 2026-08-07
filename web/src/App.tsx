import { useState } from 'react';
import { useDashboard } from './api.js';
import { LOCALES, useI18n, type Locale } from './i18n/index.js';
import { UsageChart } from './components/UsageChart.js';
import { Consumers, Feed, Levels, QueuePanel, Status, Tiles } from './components/Panels.js';
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

      {/*
        Reading order is the order the questions get asked: is it fine, how much
        have I used, then the detail behind both. Across is grouping -- the
        headline sits beside the windows it summarises, the chart beside who
        caused it, and the two live tables beside each other because they are
        read together, one being what is waiting and the other what just went.
      */}
      <div className="dash">
        <div className="cell s8">{snapshot && <Status s={snapshot} />}</div>
        <div className="cell s4">{summary && <Tiles data={summary} />}</div>

        {/* Full width: comparing five levels across six measures is what an
            aligned table is for, and it needs the room to stay aligned. */}
        <div className="cell s12">
          {snapshot && summary && <Levels s={snapshot} latency={summary.latency} />}
        </div>

        <div className="cell s8">
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
        </div>
        <div className="cell s4">{summary && <Consumers data={summary} />}</div>

        <div className="cell s6">{snapshot && <QueuePanel s={snapshot} />}</div>
        <div className="cell s6"><Feed rows={feed} /></div>
      </div>

      <Footer data={summary} />
    </div>
  );
}
