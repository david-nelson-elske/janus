/**
 * Page manifest — the typed JSON blob the server emits with each page,
 * naming which controllers may mount, with what values, on which
 * targets, and which subscriptions to open.
 *
 * The manifest is the *closed set* of controllers that may mount on a
 * given page. The client refuses to mount anything not listed. The
 * server pre-validates values against each controller's declaration
 * and pre-authorizes subscription scopes before emitting.
 *
 * Per spec §6 of CONTROLLER-API-AND-ROUTER.md.
 */

import type { ControllerDeclaration, ValueTypeDecl } from './declare';
import type { ControllerRegistry } from './registry';
import { lookupController } from './registry';

// ── Manifest shape ────────────────────────────────────────────────

export interface ManifestSubscription {
  readonly channel: string;
  readonly scope: Readonly<Record<string, unknown>>;
}

export interface ManifestControllerEntry {
  readonly name: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly subscriptions: readonly ManifestSubscription[];
}

export interface ManifestAgentAction {
  readonly controller: string;
  readonly action: string;
}

export interface ManifestAgentEntry {
  readonly sessionId: string;
  readonly allowedActions: readonly ManifestAgentAction[];
}

export interface PageManifest {
  readonly version: '1';
  readonly nonce?: string;
  readonly controllers: readonly ManifestControllerEntry[];
  readonly agent?: ManifestAgentEntry;
}

// ── Composition input ─────────────────────────────────────────────

export interface ManifestControllerInput {
  readonly name: string;
  readonly values: Readonly<Record<string, unknown>>;
  /** Subscriptions specific to this controller instance. */
  readonly subscriptions?: readonly ManifestSubscription[];
}

export interface ManifestCompositionInput {
  readonly controllers: readonly ManifestControllerInput[];
  /**
   * Page-wide subscriptions, applied to *every* controller in the
   * manifest. Use for cross-cutting topics like `ui-command`.
   */
  readonly subscriptions?: readonly ManifestSubscription[];
  readonly agent?: {
    readonly sessionId: string;
    readonly allowedActions: readonly ManifestAgentAction[];
  };
  readonly nonce?: string;
}

// ── Composition ───────────────────────────────────────────────────

/**
 * Build a `PageManifest` from loader-supplied composition input.
 *
 * Validates each controller name against the registry and each value
 * key against the declaration. Fails fast on mismatches — better an
 * exception at compose time than a manifest the client can't honour.
 */
export function composeManifest(
  registry: ControllerRegistry,
  input: ManifestCompositionInput,
): PageManifest {
  const pageSubs = input.subscriptions ?? [];
  const entries: ManifestControllerEntry[] = input.controllers.map((c) => {
    const decl = lookupController(registry, c.name);
    validateValues(decl, c.values);
    const subs = [...pageSubs, ...(c.subscriptions ?? [])];
    return {
      name: c.name,
      values: c.values,
      subscriptions: subs,
    };
  });

  if (input.agent) {
    for (const a of input.agent.allowedActions) {
      const decl = lookupController(registry, a.controller);
      if (!decl.invokable[a.action]) {
        throw new Error(
          `[composeManifest] agent.allowedActions references unknown action "${a.controller}.${a.action}"`,
        );
      }
      if (!decl.invokable[a.action].allowedActors.includes('agent-surface')) {
        throw new Error(
          `[composeManifest] action "${a.controller}.${a.action}" does not allow actor "agent-surface"`,
        );
      }
    }
  }

  return {
    version: '1',
    ...(input.nonce ? { nonce: input.nonce } : {}),
    controllers: entries,
    ...(input.agent ? { agent: input.agent } : {}),
  };
}

// ── Script rendering ─────────────────────────────────────────────

/**
 * Render the manifest as a `<script type="application/json">` element
 * suitable for embedding in the page. Escapes the JSON for safe HTML
 * embedding.
 *
 * Per spec §6 "Format" — emit near the start of `<body>`, before any
 * `data-controller` elements, with the same nonce as other scripts.
 */
export function renderManifestScript(manifest: PageManifest): string {
  const json = JSON.stringify(manifest);
  const safeJson = escapeForScript(json);
  const nonceAttr = manifest.nonce ? ` nonce="${escapeAttr(manifest.nonce)}"` : '';
  return `<script type="application/json" id="page-manifest"${nonceAttr}>${safeJson}</script>`;
}

/**
 * Render the `<script>` tag that loads the client bundle.
 *
 * Apps configure the bundle path; `nonce` reuses the manifest's.
 */
export function renderClientScript(opts: { src: string; nonce?: string }): string {
  const nonceAttr = opts.nonce ? ` nonce="${escapeAttr(opts.nonce)}"` : '';
  return `<script type="module"${nonceAttr} src="${escapeAttr(opts.src)}"></script>`;
}

// ── Value validation ─────────────────────────────────────────────

function validateValues(
  decl: ControllerDeclaration,
  values: Readonly<Record<string, unknown>>,
): void {
  for (const [key, type] of Object.entries(decl.values)) {
    const optional = type.endsWith('?');
    const baseType = optional ? (type.slice(0, -1) as ValueTypeDecl) : type;
    const present = key in values && values[key] !== undefined && values[key] !== null;
    if (!present) {
      if (optional) continue;
      throw new Error(
        `[manifest:${decl.name}] missing required value "${key}" (declared as "${type}")`,
      );
    }
    const value = values[key];
    if (!valueMatchesType(value, baseType)) {
      throw new Error(
        `[manifest:${decl.name}] value "${key}" has type "${typeof value}", expected "${type}"`,
      );
    }
  }
  for (const key of Object.keys(values)) {
    if (!(key in decl.values)) {
      throw new Error(
        `[manifest:${decl.name}] extra value "${key}" not declared in controller`,
      );
    }
  }
}

function valueMatchesType(value: unknown, baseType: string): boolean {
  switch (baseType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      // Anything JSON-serializable. We only check that it's a plain
      // object, array, or primitive — not a function/Symbol/etc.
      return value === null || ['string', 'number', 'boolean', 'object'].includes(typeof value);
    default:
      return false;
  }
}

// ── HTML escaping ────────────────────────────────────────────────

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape a JSON string for safe embedding inside a `<script>` element.
 *
 * The two things that can break out of a `<script>` block in HTML are
 * `</script>` (closes the element) and `<!--` (starts an HTML comment
 * that older parsers respect). Escape the slash and the bang to neuter
 * both without changing JSON.parse semantics — `\/` is a valid JSON
 * escape, and `<` is the canonical unicode escape for `<`.
 */
function escapeForScript(json: string): string {
  return json.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '\\u003c!--');
}
