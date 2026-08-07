import { useState } from 'react';
import { useDashboard } from './api.js';
import { LOCALES, useI18n, type Locale } from './i18n/index.js';
import { UsageChart } from './components/UsageChart.js';
import { Consumers, Feed, Levels, QueuePanel, Status } from './components/Panels.js';
import { Footer } from './components/Footer.js';
import { Playfield } from './components/Playfield.js';

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
        Reading order is the order the questions get asked: is it fine, who is
        asking, then the detail behind both. Across is grouping -- the headline
        beside the consumers it is the sum of, and the two live tables beside
        each other because they are read together. The playfield holds the right
        edge and fills whatever height the rows beside it come to; the queue sits
        directly beneath it, being the same requests it is showing, and the live
        feed beside the chart, being what the chart is made of.
      */}
      {/*
        Two regions rather than one grid. Nothing lines up across them, and
        nothing needs to: a panel matched to its neighbour's height is a panel
        padded out below its contents, which is where all the empty space came
        from. Each is as tall as what it holds.
      */}
      <div className="dash">
        <div className="main">
          <div className="cell s5">{snapshot && <Status s={snapshot} data={summary} />}</div>
          <div className="cell s4">{summary && <Consumers data={summary} />}</div>

          {/* Full width of this region: comparing five levels across eight
              measures is what an aligned table is for, and it needs the room. */}
          <div className="cell s9">
            {snapshot && summary && <Levels s={snapshot} latency={summary.latency} />}
          </div>

          <div className="cell s6">
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
          {/* What the chart is made of, beside the chart. */}
          <div className="cell s3"><Feed rows={feed} /></div>
        </div>

        {/* The playfield keeps the height it is given here rather than taking it
            from whatever happens to sit beside it, and the queue -- the same
            requests it is showing -- sits directly under it. */}
        <div className="side">
          {snapshot && (
            <Playfield s={snapshot} feed={feed} byConsumer={summary?.byConsumer ?? []} />
          )}
          {snapshot && <QueuePanel s={snapshot} />}
        </div>
      </div>

      <Footer data={summary} />
    </div>
  );
}
