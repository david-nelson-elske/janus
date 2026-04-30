/**
 * @janus/i18n unit tests — createI18n, resolver chain, fallback, switcher.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { createI18n } from '../i18n';
import { LanguageSwitcher } from '../switcher';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

function makeFixture(label: string): string {
  const dir = join(tmpdir(), `janus-i18n-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'en.json'),
    JSON.stringify({
      hero: { slogan: 'Power your balcony, not your bill' },
      petition: {
        signed_one: '{{count}} person has signed',
        signed_other: '{{count}} people have signed',
      },
    }),
  );
  writeFileSync(
    join(dir, 'fr.json'),
    JSON.stringify({
      hero: { slogan: 'Alimentez votre balcon, pas votre facture' },
      petition: {
        signed_one: '{{count}} personne a signé',
        signed_other: '{{count}} personnes ont signé',
      },
    }),
  );
  return dir;
}

describe('createI18n', () => {
  test('translates against the configured default lang', async () => {
    const dir = makeFixture('default');
    try {
      const i18n = await createI18n({ langs: ['en', 'fr'], resourcesDir: dir });
      expect(i18n.t('hero.slogan')).toBe('Power your balcony, not your bill');
      expect(i18n.t('hero.slogan', 'fr')).toBe('Alimentez votre balcon, pas votre facture');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('resolves plural forms per language', async () => {
    const dir = makeFixture('plural');
    try {
      const i18n = await createI18n({ langs: ['en', 'fr'], resourcesDir: dir });
      expect(i18n.t('petition.signed', 'en', { count: 1 })).toBe('1 person has signed');
      expect(i18n.t('petition.signed', 'en', { count: 7 })).toBe('7 people have signed');
      expect(i18n.t('petition.signed', 'fr', { count: 1 })).toBe('1 personne a signé');
      expect(i18n.t('petition.signed', 'fr', { count: 7 })).toBe('7 personnes ont signé');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('throws when defaultLang is not in langs', async () => {
    const dir = makeFixture('badlang');
    try {
      await expect(
        createI18n({ langs: ['en'], defaultLang: 'fr', resourcesDir: dir }),
      ).rejects.toThrow(/defaultLang "fr"/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('throws when a resource file is missing', async () => {
    const dir = join(tmpdir(), `janus-i18n-empty-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      await expect(createI18n({ langs: ['en'], resourcesDir: dir })).rejects.toThrow(
        /failed to load/,
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('middleware resolver chain', () => {
  test('cookie resolver picks up Cookie header', async () => {
    const dir = makeFixture('cookie');
    try {
      const i18n = await createI18n({ langs: ['en', 'fr'], resourcesDir: dir });
      const app = new Hono();
      app.use('*', i18n.middleware());
      app.get('/probe', (c) => c.text(`${c.var.lang}|${c.var.t('hero.slogan')}`));
      const res = await app.request('/probe', { headers: { cookie: 'lang=fr' } });
      expect(await res.text()).toBe('fr|Alimentez votre balcon, pas votre facture');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('falls back to default lang when no resolver matches', async () => {
    const dir = makeFixture('fallback');
    try {
      const i18n = await createI18n({ langs: ['en', 'fr'], resourcesDir: dir });
      const app = new Hono();
      app.use('*', i18n.middleware());
      app.get('/probe', (c) => c.text(c.var.lang));
      const res = await app.request('/probe');
      expect(await res.text()).toBe('en');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('Accept-Language header negotiates with quality values', async () => {
    const dir = makeFixture('accept');
    try {
      const i18n = await createI18n({
        langs: ['en', 'fr'],
        resourcesDir: dir,
        resolvers: ['accept-language'],
      });
      const app = new Hono();
      app.use('*', i18n.middleware());
      app.get('/probe', (c) => c.text(c.var.lang));

      // Strict regional preference matches primary tag
      const r1 = await app.request('/probe', { headers: { 'accept-language': 'fr-CA,en;q=0.5' } });
      expect(await r1.text()).toBe('fr');

      // Quality ordering favors high-q lang
      const r2 = await app.request('/probe', {
        headers: { 'accept-language': 'de;q=1.0,fr;q=0.8,en;q=0.1' },
      });
      expect(await r2.text()).toBe('fr');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('path-prefix resolver picks lang from URL', async () => {
    const dir = makeFixture('path');
    try {
      const i18n = await createI18n({
        langs: ['en', 'fr'],
        resourcesDir: dir,
        pathPrefix: { fr: '/fr' },
      });
      const app = new Hono();
      app.use('*', i18n.middleware());
      app.get('*', (c) => c.text(c.var.lang));
      expect(await (await app.request('/fr/quebec')).text()).toBe('fr');
      expect(await (await app.request('/quebec')).text()).toBe('en');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('resolver chain order is honored', async () => {
    const dir = makeFixture('order');
    try {
      const i18n = await createI18n({
        langs: ['en', 'fr'],
        resourcesDir: dir,
        // Cookie wins over Accept-Language even when both present
        resolvers: ['cookie', 'accept-language'],
      });
      const app = new Hono();
      app.use('*', i18n.middleware());
      app.get('/probe', (c) => c.text(c.var.lang));
      const res = await app.request('/probe', {
        headers: { cookie: 'lang=en', 'accept-language': 'fr' },
      });
      expect(await res.text()).toBe('en');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('rejects unsupported lang from cookie and falls through', async () => {
    const dir = makeFixture('badcookie');
    try {
      const i18n = await createI18n({ langs: ['en', 'fr'], resourcesDir: dir });
      const app = new Hono();
      app.use('*', i18n.middleware());
      app.get('/probe', (c) => c.text(c.var.lang));
      const res = await app.request('/probe', { headers: { cookie: 'lang=xx' } });
      expect(await res.text()).toBe('en');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('lang-set route', () => {
  test('GET /lang/<value> sets cookie and redirects', async () => {
    const dir = makeFixture('langset');
    try {
      const i18n = await createI18n({ langs: ['en', 'fr'], resourcesDir: dir });
      const app = new Hono();
      app.use('*', i18n.middleware());
      const res = await app.request('/lang/fr?redirect=%2Fquebec');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/quebec');
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('lang=fr');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('rejects unsupported lang via /lang/<value>', async () => {
    const dir = makeFixture('badlangset');
    try {
      const i18n = await createI18n({ langs: ['en', 'fr'], resourcesDir: dir });
      const app = new Hono();
      app.use('*', i18n.middleware());
      app.get('*', (c) => c.text(`fallthrough:${c.var.lang}`));
      const res = await app.request('/lang/xx?redirect=%2F');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('fallthrough:en');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('ignores cross-origin redirect targets', async () => {
    const dir = makeFixture('redirsafe');
    try {
      const i18n = await createI18n({ langs: ['en', 'fr'], resourcesDir: dir });
      const app = new Hono();
      app.use('*', i18n.middleware());
      const res = await app.request('/lang/fr?redirect=https%3A%2F%2Fevil.example.com');
      expect(res.headers.get('location')).toBe('/');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('switchHref', () => {
  test('builds /lang/<target>?redirect=<path> by default', async () => {
    const dir = makeFixture('switch');
    try {
      const i18n = await createI18n({ langs: ['en', 'fr'], resourcesDir: dir });
      expect(i18n.switchHref('/quebec', 'fr')).toBe('/lang/fr?redirect=%2Fquebec');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('falls back to ?lang= when langSetPath is disabled', async () => {
    const dir = makeFixture('switchfallback');
    try {
      const i18n = await createI18n({
        langs: ['en', 'fr'],
        resourcesDir: dir,
        langSetPath: false,
      });
      expect(i18n.switchHref('/quebec', 'fr')).toBe('/quebec?lang=fr');
      expect(i18n.switchHref('/blog?p=1', 'fr')).toBe('/blog?p=1&lang=fr');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('LanguageSwitcher', () => {
  test('renders inline links with active marker', async () => {
    const dir = makeFixture('lswinline');
    try {
      const i18n = await createI18n({ langs: ['en', 'fr'], resourcesDir: dir });
      const html = renderToString(
        h(LanguageSwitcher, { i18n, currentPath: '/quebec', currentLang: 'en' }),
      );
      expect(html).toContain('aria-current="true"');
      expect(html).toContain('EN');
      expect(html).toContain('href="/lang/fr?redirect=%2Fquebec"');
      expect(html).toContain('FR');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('respects custom labels', async () => {
    const dir = makeFixture('lswlabels');
    try {
      const i18n = await createI18n({ langs: ['en', 'fr'], resourcesDir: dir });
      const html = renderToString(
        h(LanguageSwitcher, {
          i18n,
          currentPath: '/',
          currentLang: 'fr',
          labels: { en: 'English', fr: 'Français' },
        }),
      );
      expect(html).toContain('English');
      expect(html).toContain('Français');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
