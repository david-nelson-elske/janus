/**
 * Preact context plumbing for SSR translation.
 *
 * `LangContext.Provider` is set by the SSR renderer with the active language
 * and translator. Components consume via `useT()` (translator) and `useLang()`
 * (language code).
 */

import type { TOptions } from 'i18next';
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

export type Translator = (key: string, opts?: TOptions) => string;

export interface LangContextValue {
  readonly lang: string;
  readonly t: Translator;
}

const FALLBACK_TRANSLATOR: Translator = (key) => key;

export const LangContext = createContext<LangContextValue>({
  lang: 'en',
  t: FALLBACK_TRANSLATOR,
});

export function useLang(): string {
  return useContext(LangContext).lang;
}

export function useT(): Translator {
  return useContext(LangContext).t;
}
