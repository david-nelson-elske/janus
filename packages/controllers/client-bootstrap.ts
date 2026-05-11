/**
 * Client bootstrap — runs in the browser.
 *
 * Reads `#page-manifest`, instantiates a Stimulus `Application`,
 * registers only the controllers named in the manifest, and starts.
 *
 * Per spec §6 invariants:
 * - Closed set: only controllers in the manifest may mount.
 * - Pre-validated values: the client coerces (via Stimulus) but does
 *   not re-validate.
 * - Pre-authorized subscriptions: the server has already verified.
 *
 * Per spec §7 named-invocation: installs a `globalThis.__janusInvoke`
 * implementation so `JanusController#invoke` resolves the target.
 */

import { Application, type Controller, type ControllerConstructor } from '@hotwired/stimulus';
import type { PageManifest } from './manifest';
import { collectAllSubscriptions, installManifestLookup } from './manifest-lookup';
import { configureChannelClient, openClientStream } from '@janus/channels/client';

export interface BootOptions {
  /**
   * Map of controller name → controller class. Only controllers whose
   * name appears in the manifest will be registered; the rest are
   * skipped (with a debug log in dev mode).
   */
  readonly controllers: Readonly<Record<string, ControllerConstructor>>;

  /**
   * When true, the bootstrap logs detail about its decisions: skipped
   * controllers, mismatched data-controller attributes, etc. Defaults
   * to true when `location.hostname` is `localhost` or `127.0.0.1`.
   */
  readonly devMode?: boolean;

  /**
   * Optional override for the SSE endpoint the channel client opens.
   * Defaults to `/api/channels/stream` (matches `@janus/channels/server`).
   */
  readonly channelStreamPath?: string;

  /**
   * Optional hook called once the Stimulus application has started
   * and all eligible controllers have been registered.
   */
  readonly onReady?: (app: Application) => void;
}

export interface BootResult {
  readonly app: Application | null;
  readonly manifest: PageManifest | null;
  readonly registered: readonly string[];
}

/**
 * Read the manifest, start the Stimulus application, register
 * manifest-allowed controllers. Returns the app + manifest so callers
 * can wire app-specific extensions (e.g. agent-runtime publishes).
 */
export function bootControllers(opts: BootOptions): BootResult {
  const devMode = opts.devMode ?? isLikelyDev();
  const manifest = readManifest(devMode);
  if (!manifest) {
    return { app: null, manifest: null, registered: [] };
  }

  // Install the manifest so `JanusController#subscribe()` can resolve
  // the SSR-declared subscription scopes for the calling controller.
  installManifestLookup(manifest);

  // Open the page-wide SSE stream with the union of all declared
  // subscriptions. Controllers register handlers in `janusConnect()`;
  // their handlers attach to the already-open stream.
  if (opts.channelStreamPath) {
    configureChannelClient({ streamPath: opts.channelStreamPath });
  }
  const subs = collectAllSubscriptions();
  if (subs.length > 0) {
    openClientStream(subs);
  }

  const allowed = new Set(manifest.controllers.map((c) => c.name));
  const app = Application.start();
  const registered: string[] = [];

  for (const [name, ctor] of Object.entries(opts.controllers)) {
    if (!allowed.has(name)) {
      if (devMode) {
        // biome-ignore lint/suspicious/noConsole: dev diagnostics
        console.debug(`[janus] controller "${name}" registered in bundle but not in manifest — skipping`);
      }
      continue;
    }
    app.register(name, ctor);
    registered.push(name);
  }

  installInvokeBridge(app);

  if (devMode) {
    scheduleManifestSanityCheck(allowed);
  }

  opts.onReady?.(app);

  return { app, manifest, registered };
}

// ── Manifest reading ──────────────────────────────────────────────

function readManifest(devMode: boolean): PageManifest | null {
  const el = document.getElementById('page-manifest');
  if (!el) {
    if (devMode) {
      // biome-ignore lint/suspicious/noConsole: dev diagnostics
      console.warn('[janus] no #page-manifest element found — no controllers will mount');
    }
    return null;
  }
  try {
    const parsed = JSON.parse(el.textContent ?? '{}') as PageManifest;
    if (parsed.version !== '1') {
      // biome-ignore lint/suspicious/noConsole: misconfigured manifest is dev-worthy
      console.error(`[janus] unsupported manifest version "${parsed.version}"`);
      return null;
    }
    return parsed;
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: parse failure is dev-worthy
    console.error('[janus] failed to parse #page-manifest', err);
    return null;
  }
}

// ── Cross-controller invoke bridge ────────────────────────────────

function installInvokeBridge(app: Application): void {
  (globalThis as {
    __janusInvoke?: (controller: string, action: string, params: Record<string, unknown>) => Promise<void>;
  }).__janusInvoke = async (controllerName, action, params) => {
    // Find every mounted instance of the named controller across the page.
    const els = document.querySelectorAll(`[data-controller~="${cssEscape(controllerName)}"]`);
    let invoked = 0;
    for (const el of els) {
      const ctl = app.getControllerForElementAndIdentifier(el as Element, controllerName) as
        | (Controller<HTMLElement> & Record<string, unknown>)
        | null;
      if (!ctl) continue;
      const method = ctl[action];
      if (typeof method !== 'function') {
        // biome-ignore lint/suspicious/noConsole: visible failure beats silent
        console.error(`[janus] invoke("${controllerName}#${action}") — method not found on instance`, ctl);
        continue;
      }
      await (method as (p: Record<string, unknown>) => unknown).call(ctl, params);
      invoked++;
    }
    if (invoked === 0) {
      // biome-ignore lint/suspicious/noConsole: dev diagnostics
      console.warn(`[janus] invoke("${controllerName}#${action}") — no mounted instances`);
    }
  };
}

// ── Dev-mode sanity check ─────────────────────────────────────────

function scheduleManifestSanityCheck(allowed: ReadonlySet<string>): void {
  // Defer one tick so initial Stimulus mount has run.
  setTimeout(() => {
    const els = document.querySelectorAll('[data-controller]');
    for (const el of els) {
      const names = (el.getAttribute('data-controller') ?? '').split(/\s+/).filter(Boolean);
      for (const name of names) {
        if (!allowed.has(name)) {
          // biome-ignore lint/suspicious/noConsole: catches real mistakes early
          console.error(
            `[janus] element declares data-controller="${name}" but it is not in the page manifest — will not mount`,
            el,
          );
        }
      }
    }
  }, 0);
}

// ── Helpers ───────────────────────────────────────────────────────

function isLikelyDev(): boolean {
  if (typeof location === 'undefined') return false;
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

function cssEscape(s: string): string {
  // CSS.escape is widely supported; fall back for older runtimes that
  // we hit during testing/SSR. Names are kebab-case so the fallback's
  // simple ASCII handling is enough for our identifier vocabulary.
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
