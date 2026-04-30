/**
 * @janus/i18n — request-time language resolution + SSR translation for Janus apps.
 *
 * Three lines of bootstrap make any app bilingual:
 *
 *   const i18n = await createI18n({ langs: ['en','fr'], resourcesDir: 'lang' });
 *   app.use('*', i18n.middleware());
 *   // pass `i18n` into createApp() so the SSR renderer wraps Preact in LangContext.
 */

export {
  createI18n,
  type I18nConfig,
  type I18nInstance,
  type LangResolver,
} from './i18n';

export {
  LangContext,
  type LangContextValue,
  type Translator,
  useLang,
  useT,
} from './context';

export { LanguageSwitcher, type LanguageSwitcherProps } from './switcher';

export { checkParity, formatParityReport, type ParityReport } from './parity';
