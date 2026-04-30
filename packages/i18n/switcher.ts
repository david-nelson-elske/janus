/**
 * Server-rendered language switcher.
 *
 * The framework's reference switcher: each supported language gets a link
 * built via `i18n.switchHref(currentPath, lang)`. By default the cookie-set
 * route handles the actual write; apps that disable that route should
 * provide their own component.
 *
 * Variants:
 *   - 'inline'   — comma-separated link list (default)
 *   - 'dropdown' — `<select>` with onchange navigation (progressive enhancement)
 */

import { type VNode, h } from 'preact';
import type { I18nInstance } from './i18n';

export interface LanguageSwitcherProps {
  readonly i18n: I18nInstance;
  readonly currentPath: string;
  readonly currentLang: string;
  readonly variant?: 'inline' | 'dropdown';
  readonly className?: string;
  /** Optional label override per lang (e.g. `{en:'EN', fr:'FR'}`). */
  readonly labels?: Readonly<Record<string, string>>;
}

export function LanguageSwitcher(props: LanguageSwitcherProps): VNode {
  const { i18n, currentPath, currentLang, variant = 'inline', className, labels } = props;
  const labelFor = (lang: string) => labels?.[lang] ?? lang.toUpperCase();

  if (variant === 'dropdown') {
    return h(
      'select',
      {
        class: className ?? 'janus-lang-switcher',
        'aria-label': 'Language',
        onchange: 'this.options[this.selectedIndex].dataset.href && (location.href=this.options[this.selectedIndex].dataset.href)',
      },
      ...i18n.langs.map((lang) =>
        h(
          'option',
          {
            value: lang,
            selected: lang === currentLang,
            'data-href': i18n.switchHref(currentPath, lang),
          },
          labelFor(lang),
        ),
      ),
    );
  }

  return h(
    'span',
    { class: className ?? 'janus-lang-switcher' },
    ...interleave(
      i18n.langs.map((lang) =>
        lang === currentLang
          ? h('span', { class: 'janus-lang-current', 'aria-current': 'true' }, labelFor(lang))
          : h(
              'a',
              { href: i18n.switchHref(currentPath, lang), class: 'janus-lang-link' },
              labelFor(lang),
            ),
      ),
      () => h('span', { class: 'janus-lang-sep', 'aria-hidden': 'true' }, ' / '),
    ),
  );
}

function interleave<T>(items: readonly T[], sep: () => T): T[] {
  const out: T[] = [];
  items.forEach((item, idx) => {
    if (idx > 0) out.push(sep());
    out.push(item);
  });
  return out;
}
