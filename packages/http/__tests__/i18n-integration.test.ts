/**
 * End-to-end SSR i18n test — cookie → middleware → renderer.
 *
 * Verifies the seam from request to emitted HTML: <html lang> reflects the
 * resolved language, hreflang alternates emit for every supported lang, and
 * a Preact component using useT() reads its translation from the active
 * language catalog.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bind, clearRegistry, define, participate } from '@janus/core';
import { createI18n, useT } from '@janus/i18n';
import { Persistent, Str } from '@janus/vocabulary';
import { h } from 'preact';
import { type App, apiSurface, createApp } from '..';

function makeFixture(label: string): string {
  const dir = join(
    tmpdir(),
    `janus-http-i18n-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'en.json'), JSON.stringify({ greeting: 'Hello' }));
  writeFileSync(join(dir, 'fr.json'), JSON.stringify({ greeting: 'Bonjour' }));
  return dir;
}

const Greeting = (() => {
  // useT() reads the LangContext set up by the SSR renderer.
  return () => {
    const t = useT();
    return h('p', { id: 'greet' }, t('greeting'));
  };
})();

let app: App | undefined;

afterEach(async () => {
  if (app) {
    await app.shutdown();
    app = undefined;
  }
  clearRegistry();
});

describe('SSR i18n integration', () => {
  test('cookie sets <html lang> and translation in render', async () => {
    const dir = makeFixture('cookie');
    try {
      clearRegistry();
      const i18n = await createI18n({ langs: ['en', 'fr'], resourcesDir: dir });

      const widget = define('widget', {
        schema: { title: Str({ required: true }) },
        storage: Persistent(),
      });
      const widgetP = participate(widget, {});
      const widgetB = bind(widget, [
        {
          component: Greeting as any,
          view: 'list',
          config: { fields: { title: { agent: 'read' as const } } },
        },
      ]);

      app = await createApp({
        declarations: [widget, widgetP, widgetB],
        surfaces: [apiSurface()],
        i18n,
      });

      const enRes = await app.fetch(new Request('http://localhost/widgets'));
      const enHtml = await enRes.text();
      expect(enHtml).toContain('<html lang="en">');
      expect(enHtml).toContain('id="greet"');
      expect(enHtml).toContain('Hello');
      expect(enHtml).toContain('hreflang="en"');
      expect(enHtml).toContain('hreflang="fr"');
      expect(enHtml).toContain('hreflang="x-default"');

      const frRes = await app.fetch(
        new Request('http://localhost/widgets', { headers: { cookie: 'lang=fr' } }),
      );
      const frHtml = await frRes.text();
      expect(frHtml).toContain('<html lang="fr">');
      expect(frHtml).toContain('Bonjour');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('GET /lang/<value> sets cookie and redirects', async () => {
    const dir = makeFixture('langset');
    try {
      clearRegistry();
      const i18n = await createI18n({ langs: ['en', 'fr'], resourcesDir: dir });

      const widget = define('widget', {
        schema: { title: Str({ required: true }) },
        storage: Persistent(),
      });
      const widgetP = participate(widget, {});
      const widgetB = bind(widget, [
        {
          component: Greeting as any,
          view: 'list',
          config: { fields: { title: { agent: 'read' as const } } },
        },
      ]);

      app = await createApp({
        declarations: [widget, widgetP, widgetB],
        surfaces: [apiSurface()],
        i18n,
      });

      const res = await app.fetch(
        new Request('http://localhost/lang/fr?redirect=%2Fwidgets'),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/widgets');
      expect(res.headers.get('set-cookie') ?? '').toContain('lang=fr');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
