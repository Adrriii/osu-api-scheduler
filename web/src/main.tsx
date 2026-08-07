import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { LocaleContext, LOCALES, detectLocale, type Locale } from './i18n/index.js';
import './styles.css';

function Root() {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const value = useMemo(
    () => ({
      locale,
      setLocale: (l: Locale) => {
        localStorage.setItem('locale', l);
        document.documentElement.lang = l;
        setLocaleState(l);
      },
      t: LOCALES[locale].dict,
    }),
    [locale],
  );

  document.documentElement.lang = locale;
  return (
    <LocaleContext.Provider value={value}>
      <App />
    </LocaleContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
