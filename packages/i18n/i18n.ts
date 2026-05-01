/**
 * createI18n() — Core i18n instance for Janus apps.
 *
 * Two layouts supported for `resourcesDir`:
 *   1. Single-file:  `<dir>/<lang>.json`            → one namespace ('translation')
 *   2. Directory:    `<dir>/<lang>/<ns>.json`       → one namespace per file
 *
 * Resolves the active language per request via a configurable resolver
 * chain (path → cookie → query → accept-language → default), and exposes
 * the active language + translator on the Hono context (`c.var.lang`,
 * `c.var.t`). With multi-namespace catalogs, callers use the i18next
 * colon syntax: `t('blog:heading')` or `t('common:nav.takeAction')`.
 *
 * Use `i18n.middleware()` to mount; `useLang()` / `useT()` from `./context`
 * read the active language inside Preact components.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Context, MiddlewareHandler } from 'hono';
import { setCookie } from 'hono/cookie';
import i18next, { type i18n as I18Next, type TOptions } from 'i18next';

// ── Public types ───────────────────────────────────────────────────

export type LangResolver = 'cookie' | 'path' | 'accept-language' | 'query';

export interface I18nConfig {
  /** Supported language codes. First is the default unless `defaultLang` is set. */
  readonly langs: readonly string[];
  /** Default language. Must be in `langs`. Defaults to `langs[0]`. */
  readonly defaultLang?: string;
  /** Path to translation resource directory. Layout: `<dir>/<lang>.json`. */
  readonly resourcesDir: string;
  /** Resolver chain order. Default: `['path','cookie','query','accept-language']`. */
  readonly resolvers?: readonly LangResolver[];
  /** Cookie name used by the `cookie` resolver. Default: `'lang'`. */
  readonly cookieName?: string;
  /** Cookie max-age in seconds. Default: 1 year. */
  readonly cookieMaxAge?: number;
  /**
   * URL path prefixes per non-default language. When set, requests matching
   * `/<prefix>/<rest>` resolve to that lang. Routes are NOT auto-mirrored —
   * apps still own routing; this only sets the active language.
   */
  readonly pathPrefix?: Readonly<Record<string, string>>;
  /** Query parameter name used by the `query` resolver. Default: `'lang'`. */
  readonly queryParam?: string;
  /**
   * Mount a `GET /<langSetPath>/<value>?redirect=<path>` cookie-set route.
   * Set to `false` to disable. Default: `'/lang'`.
   */
  readonly langSetPath?: string | false;
  /**
   * When a translatable read returns null/empty in the active lang, fall
   * back to the default lang. Default: `true`.
   */
  readonly fallbackOnMissing?: boolean;
  /** Per-namespace and global i18next options passthrough (advanced). */
  readonly i18nextOptions?: Record<string, unknown>;
}

export interface I18nInstance {
  /** Hono middleware. Sets `c.var.lang` and `c.var.t`; mounts the lang-set route. */
  middleware(): MiddlewareHandler;
  /** Translate a key for a specific lang. */
  t(key: string, lang?: string, opts?: TOptions): string;
  /** All configured languages. */
  readonly langs: readonly string[];
  /** Default language. */
  readonly defaultLang: string;
  /** Resolver chain order. */
  readonly resolvers: readonly LangResolver[];
  /** Path-prefix lookup (lang → '/fr'). */
  readonly pathPrefix: Readonly<Record<string, string>>;
  /** Build a switch URL for the current path. */
  switchHref(currentPath: string, targetLang: string): string;
  /** Underlying i18next instance (escape hatch). */
  readonly i18next: I18Next;
  /** Whether to fall back to default-lang content on missing translations. */
  readonly fallbackOnMissing: boolean;
}

declare module 'hono' {
  interface ContextVariableMap {
    lang: string;
    t: (key: string, opts?: TOptions) => string;
  }
}

// ── Defaults ───────────────────────────────────────────────────────

const DEFAULT_RESOLVERS: readonly LangResolver[] = [
  'path',
  'cookie',
  'query',
  'accept-language',
];
const DEFAULT_COOKIE_NAME = 'lang';
const DEFAULT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const DEFAULT_QUERY_PARAM = 'lang';
const DEFAULT_LANG_SET_PATH = '/lang';

// ── Public API ─────────────────────────────────────────────────────

export async function createI18n(config: I18nConfig): Promise<I18nInstance> {
  const langs = [...config.langs];
  if (langs.length === 0) {
    throw new Error('createI18n: at least one language is required');
  }
  const defaultLang = config.defaultLang ?? langs[0];
  if (!langs.includes(defaultLang)) {
    throw new Error(`createI18n: defaultLang "${defaultLang}" not in langs ${JSON.stringify(langs)}`);
  }

  const { resources, namespaces } = await loadResources(config.resourcesDir, langs);

  // defaultNS: 'common' if catalog defines it (multi-namespace mode),
  // otherwise 'translation' (single-file backwards-compat mode).
  const defaultNS = namespaces.includes('common') ? 'common'
    : namespaces.includes('translation') ? 'translation'
    : namespaces[0];

  const instance = i18next.createInstance();
  await instance.init({
    resources,
    lng: defaultLang,
    fallbackLng: defaultLang,
    supportedLngs: langs,
    ns: namespaces,
    defaultNS,
    interpolation: { escapeValue: false }, // SSR escapes downstream
    returnNull: false,
    returnEmptyString: false,
    ...(config.i18nextOptions ?? {}),
  });

  const resolvers = config.resolvers ?? DEFAULT_RESOLVERS;
  const cookieName = config.cookieName ?? DEFAULT_COOKIE_NAME;
  const cookieMaxAge = config.cookieMaxAge ?? DEFAULT_COOKIE_MAX_AGE;
  const queryParam = config.queryParam ?? DEFAULT_QUERY_PARAM;
  const pathPrefix = config.pathPrefix ?? {};
  const langSetPath = config.langSetPath ?? DEFAULT_LANG_SET_PATH;
  const fallbackOnMissing = config.fallbackOnMissing ?? true;

  const t = (key: string, lang?: string, opts?: TOptions): string => {
    const targetLang = lang ?? defaultLang;
    return instance.getFixedT(targetLang)(key, opts as TOptions) as string;
  };

  const switchHref = (currentPath: string, targetLang: string): string => {
    if (langSetPath === false) {
      // No cookie route mounted — apps should override switchHref via custom switcher.
      // Fallback: use ?lang=<target> on the current path.
      const sep = currentPath.includes('?') ? '&' : '?';
      return `${currentPath}${sep}${queryParam}=${encodeURIComponent(targetLang)}`;
    }
    const prefix = langSetPath.endsWith('/') ? langSetPath.slice(0, -1) : langSetPath;
    return `${prefix}/${encodeURIComponent(targetLang)}?redirect=${encodeURIComponent(currentPath)}`;
  };

  const middleware = (): MiddlewareHandler => {
    return async (c, next) => {
      // Handle the lang-set route first (cookie write + redirect).
      if (langSetPath !== false) {
        const setMatch = matchLangSetPath(c.req.path, langSetPath);
        if (setMatch && langs.includes(setMatch)) {
          setCookie(c, cookieName, setMatch, {
            maxAge: cookieMaxAge,
            path: '/',
            sameSite: 'Lax',
            httpOnly: false,
          });
          const redirect = c.req.query('redirect') ?? '/';
          return c.redirect(safeRedirect(redirect));
        }
      }

      const lang = resolveLang(c, {
        resolvers,
        langs,
        defaultLang,
        cookieName,
        queryParam,
        pathPrefix,
      });
      c.set('lang', lang);
      c.set('t', (key: string, opts?: TOptions) => t(key, lang, opts));
      await next();
    };
  };

  return {
    middleware,
    t,
    langs,
    defaultLang,
    resolvers,
    pathPrefix,
    switchHref,
    i18next: instance,
    fallbackOnMissing,
  };
}

// ── Resolver chain ─────────────────────────────────────────────────

interface ResolveContext {
  resolvers: readonly LangResolver[];
  langs: readonly string[];
  defaultLang: string;
  cookieName: string;
  queryParam: string;
  pathPrefix: Readonly<Record<string, string>>;
}

function resolveLang(c: Context, ctx: ResolveContext): string {
  for (const resolver of ctx.resolvers) {
    const candidate = runResolver(resolver, c, ctx);
    if (candidate && ctx.langs.includes(candidate)) return candidate;
  }
  return ctx.defaultLang;
}

function runResolver(
  resolver: LangResolver,
  c: Context,
  ctx: ResolveContext,
): string | undefined {
  switch (resolver) {
    case 'path':
      return resolveFromPath(c.req.path, ctx.pathPrefix);
    case 'cookie':
      return resolveFromCookie(c.req.header('cookie'), ctx.cookieName);
    case 'query':
      return c.req.query(ctx.queryParam) ?? undefined;
    case 'accept-language':
      return resolveFromAcceptLanguage(c.req.header('accept-language'), ctx.langs);
  }
}

function resolveFromPath(
  path: string,
  pathPrefix: Readonly<Record<string, string>>,
): string | undefined {
  for (const [lang, prefix] of Object.entries(pathPrefix)) {
    const normalized = prefix.startsWith('/') ? prefix : `/${prefix}`;
    if (path === normalized || path.startsWith(`${normalized}/`)) {
      return lang;
    }
  }
  return undefined;
}

function resolveFromCookie(
  cookieHeader: string | undefined,
  cookieName: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  // Match `name=value` segments without locale-specific assumptions.
  const re = new RegExp(`(?:^|;\\s*)${escapeRegex(cookieName)}=([^;]+)`);
  const m = cookieHeader.match(re);
  return m?.[1];
}

function resolveFromAcceptLanguage(
  header: string | undefined,
  langs: readonly string[],
): string | undefined {
  if (!header) return undefined;
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      const quality = q ? Number(q.trim().slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);
  const lower = langs.map((l) => l.toLowerCase());
  for (const { tag } of ranked) {
    const exact = lower.indexOf(tag);
    if (exact !== -1) return langs[exact];
    const primary = tag.split('-')[0];
    const partial = lower.indexOf(primary);
    if (partial !== -1) return langs[partial];
  }
  return undefined;
}

// ── Lang-set route helpers ─────────────────────────────────────────

function matchLangSetPath(path: string, langSetPath: string): string | undefined {
  const prefix = langSetPath.endsWith('/') ? langSetPath.slice(0, -1) : langSetPath;
  if (!path.startsWith(`${prefix}/`)) return undefined;
  const rest = path.slice(prefix.length + 1);
  if (rest.length === 0 || rest.includes('/')) return undefined;
  return decodeURIComponent(rest);
}

function safeRedirect(target: string): string {
  // Only allow same-origin paths; strip protocol/host attempts.
  if (!target.startsWith('/') || target.startsWith('//')) return '/';
  return target;
}

// ── Resource loading ───────────────────────────────────────────────

/**
 * Load translation resources. Supports two layouts:
 *
 *   Single-file:  <dir>/<lang>.json
 *     → one namespace 'translation' per language; existing apps continue working.
 *
 *   Directory:    <dir>/<lang>/<namespace>.json
 *     → one namespace per file. Detected when <dir>/<lang> is a directory.
 *
 * Returned shape matches i18next's resources contract:
 *   resources[lang][namespace] = { ...keys }
 */
async function loadResources(
  dir: string,
  langs: readonly string[],
): Promise<{
  resources: Record<string, Record<string, Record<string, unknown>>>;
  namespaces: readonly string[];
}> {
  const resources: Record<string, Record<string, Record<string, unknown>>> = {};
  const namespaceSet = new Set<string>();

  for (const lang of langs) {
    const langDir = join(dir, lang);
    const langFile = join(dir, `${lang}.json`);

    let stat: { isDirectory(): boolean } | null = null;
    try {
      stat = await fs.stat(langDir);
    } catch { /* not a directory — fall through to single-file mode */ }

    resources[lang] = {};

    if (stat?.isDirectory()) {
      // Directory mode: each .json file is a namespace.
      const entries = await fs.readdir(langDir);
      const nsFiles = entries.filter((f) => f.endsWith('.json'));
      if (nsFiles.length === 0) {
        throw new Error(`createI18n: no .json files in ${langDir}`);
      }
      for (const file of nsFiles) {
        const ns = file.slice(0, -'.json'.length);
        const path = join(langDir, file);
        try {
          const raw = await fs.readFile(path, 'utf-8');
          resources[lang][ns] = JSON.parse(raw) as Record<string, unknown>;
          namespaceSet.add(ns);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`createI18n: failed to load ${path}: ${msg}`);
        }
      }
    } else {
      // Single-file mode: backwards compatible.
      try {
        const raw = await fs.readFile(langFile, 'utf-8');
        resources[lang].translation = JSON.parse(raw) as Record<string, unknown>;
        namespaceSet.add('translation');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`createI18n: failed to load ${langFile}: ${msg}`);
      }
    }
  }

  return { resources, namespaces: [...namespaceSet].sort() };
}

// ── Utils ──────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
