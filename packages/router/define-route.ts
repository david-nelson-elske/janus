/**
 * defineRoute — the v1 route → loader → projection → binding → manifest
 * pipeline.
 *
 * Per spec §9 of CONTROLLER-API-AND-ROUTER.md.
 *
 * The router is a thin wrapper over Hono. Routes declare a loader that
 * returns (a) the typed view passed to the binding, (b) which
 * controllers may mount on the page, (c) which channel subscriptions
 * to open, and (d) which agent actions are allowed for this page.
 *
 * Phase 0 status: usable for new routes. Existing perspicuity routes
 * keep their hand-written Hono handlers and call the lower-level
 * `composeManifest` / `renderManifestScript` from `@janus/controllers`
 * directly. Spec §13 phases 1-3 migrate routes onto `defineRoute`.
 */

import type { Context, Hono } from 'hono';
import type {
  ControllerRegistry,
  ManifestAgentAction,
  ManifestControllerInput,
  ManifestSubscription,
  PageManifest,
} from '@janus/controllers';
import {
  composeManifest,
  renderClientScript,
  renderManifestScript,
} from '@janus/controllers';

// ── HTTP method ───────────────────────────────────────────────────

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

// ── Loader result ─────────────────────────────────────────────────

export interface LoaderResult<TView = unknown> {
  /** Typed view-model handed to the binding for SSR. */
  readonly view: TView;
  /** Controllers permitted to mount on this page. */
  readonly controllers: readonly ManifestControllerInput[];
  /** Channel subscriptions to open on page load. */
  readonly subscriptions?: readonly ManifestSubscription[];
  /**
   * Agent actions allowed on this page. In v1 these are hand-listed;
   * spec 5 derives them from the compiled capability graph.
   */
  readonly agentAllowedActions?: readonly ManifestAgentAction[];
  /** Session id the agent runtime targets for `ui-command` publishes. */
  readonly agentSessionId?: string;
  /** Optional per-page CSP nonce. Reused by manifest + bundle script. */
  readonly nonce?: string;
}

// ── Binding ───────────────────────────────────────────────────────

export interface BindingContext<TView> {
  readonly view: TView;
  readonly manifest: PageManifest;
  /** Pre-rendered `<script>` tags ready to drop into the page. */
  readonly scripts: {
    /** The `<script type="application/json" id="page-manifest">…</script>` element. */
    readonly manifest: string;
    /** The `<script type="module" src="…">…</script>` element for the client bundle. */
    readonly bundle: string;
  };
  readonly request: Context;
}

/**
 * A binding takes the loader-supplied view + the composed manifest +
 * the pre-rendered script tags and returns the full HTML response
 * body. Bindings are free to use Preact + `renderToString`, raw
 * template strings, or any other HTML producer.
 */
export type Binding<TView> = (ctx: BindingContext<TView>) => string | Promise<string>;

// ── defineRoute ───────────────────────────────────────────────────

export interface DefineRouteConfig<TView = unknown> {
  readonly path: string;
  readonly method: HttpMethod;
  readonly loader: (c: Context) => LoaderResult<TView> | Promise<LoaderResult<TView>>;
  readonly binding: Binding<TView>;
}

export interface DefineRouteContext {
  /**
   * Controller registry used to validate the loader's controller
   * references and value shapes at compose time.
   */
  readonly registry: ControllerRegistry;
  /** URL the client bundle is served from (e.g. `/static/client.js`). */
  readonly clientBundleUrl: string;
}

/**
 * Mount a v1 route on a Hono app. Returns the same app for chaining.
 */
export function defineRoute<TView = unknown>(
  app: Hono,
  config: DefineRouteConfig<TView>,
  ctx: DefineRouteContext,
): Hono {
  const handler = async (c: Context): Promise<Response> => {
    const result = await config.loader(c);

    const manifest = composeManifest(ctx.registry, {
      controllers: result.controllers,
      subscriptions: result.subscriptions,
      agent: result.agentAllowedActions
        ? {
            sessionId: result.agentSessionId ?? '',
            allowedActions: result.agentAllowedActions,
          }
        : undefined,
      nonce: result.nonce,
    });

    const scripts = {
      manifest: renderManifestScript(manifest),
      bundle: renderClientScript({ src: ctx.clientBundleUrl, nonce: result.nonce }),
    };

    const html = await config.binding({
      view: result.view,
      manifest,
      scripts,
      request: c,
    });

    return c.html(html);
  };

  app[config.method](config.path, handler);
  return app;
}
