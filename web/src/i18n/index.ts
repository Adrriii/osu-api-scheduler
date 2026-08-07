import { createContext, useContext } from 'react';
import { en } from './en.js';
import { fr } from './fr.js';

/**
 * Deliberately tiny rather than pulling in an i18n framework. The dashboard has
 * a few dozen strings and no plural rules or gendered forms to speak of; a
 * dependency would be more code than it replaces, and this keeps the bundle
 * small enough to matter on a self-hosted tool.
 *
 * `en` is the shape every other locale is checked against at compile time, so a
 * missing or misspelled key is a build error rather than a blank label.
 */
/**
 * `en` is written `as const` so key completion works while editing, but a
 * translation obviously has different *values* -- so the contract other locales
 * satisfy widens the literals back to `string`. Structure still has to match
 * exactly, which is the point: a missing or misspelled key fails the build
 * rather than rendering a blank label.
 */
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Dict = Widen<typeof en>;

export const LOCALES = {
  en: { label: 'English', dict: en },
  fr: { label: 'Français', dict: fr },
} as const;

export type Locale = keyof typeof LOCALES;

export function isLocale(v: string): v is Locale {
  return Object.hasOwn(LOCALES, v);
}

/** Stored choice, else the browser's preference, else English. */
export function detectLocale(): Locale {
  const stored = localStorage.getItem('locale');
  if (stored && isLocale(stored)) return stored;
  for (const tag of navigator.languages ?? []) {
    const base = tag.split('-')[0] ?? '';
    if (isLocale(base)) return base;
  }
  return 'en';
}

export const LocaleContext = createContext<{
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: Dict;
}>({ locale: 'en', setLocale: () => {}, t: en });

export const useI18n = () => useContext(LocaleContext);

/** Interpolates {name} placeholders. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole,
  );
}
