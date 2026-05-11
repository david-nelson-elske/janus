/**
 * SSR attribute helpers — emit the exact `data-*` attributes the
 * client reads when mounting controllers.
 *
 * Stimulus's per-key value attributes (`data-{name}-{key}-value`) are
 * kept because Stimulus's coercion is per-key and well-tested. A
 * single JSON blob attribute was rejected — see spec §8 "Why we keep
 * Stimulus's per-key value attributes."
 */

import type { ControllerDeclaration } from './declare';
import type { ControllerRegistry } from './registry';
import { lookupController } from './registry';

// ── controllerAttrs ───────────────────────────────────────────────

/**
 * Build the `data-controller` + `data-{name}-{key}-value` attributes
 * for an element that mounts a controller.
 *
 * In dev mode (`NODE_ENV !== 'production'`), validates the controller
 * name + value keys against the registry. In production the check
 * is skipped — the manifest emitter already validated at compose time.
 *
 * Usage in a Preact binding:
 *
 *   <div {...controllerAttrs('decision-doc', { decisionId: 'd_42' }, registry)}>
 */
export function controllerAttrs(
  name: string,
  values: Readonly<Record<string, unknown>>,
  registry?: ControllerRegistry,
): Record<string, string> {
  if (registry && isDevMode()) {
    const decl = lookupController(registry, name);
    validateValueKeys(decl, values);
  }

  const attrs: Record<string, string> = { 'data-controller': name };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const attrName = `data-${name}-${kebabize(key)}-value`;
    attrs[attrName] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return attrs;
}

// ── targetAttr ────────────────────────────────────────────────────

/**
 * Build the `data-{name}-target` attribute for an element that is a
 * target of a controller. Per spec §8.
 */
export function targetAttr(name: string, target: string): Record<string, string> {
  return { [`data-${name}-target`]: target };
}

// ── actionAttr ────────────────────────────────────────────────────

/**
 * Build the `data-action` attribute for an event-handler wiring. Per
 * Stimulus's default action syntax: `event->controller#method`.
 *
 * Usage:
 *
 *   <button {...actionAttr('click', 'decision-doc', 'submit')}>
 */
export function actionAttr(
  event: string,
  name: string,
  method: string,
): Record<string, string> {
  return { 'data-action': `${event}->${name}#${method}` };
}

// ── Helpers ──────────────────────────────────────────────────────

function kebabize(camel: string): string {
  return camel.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function validateValueKeys(
  decl: ControllerDeclaration,
  values: Readonly<Record<string, unknown>>,
): void {
  for (const key of Object.keys(values)) {
    if (!(key in decl.values)) {
      throw new Error(
        `[controllerAttrs:${decl.name}] value "${key}" not declared in controller (declared: [${Object.keys(decl.values).join(', ')}])`,
      );
    }
  }
}

function isDevMode(): boolean {
  if (typeof process === 'undefined') return false;
  return process.env.NODE_ENV !== 'production';
}
