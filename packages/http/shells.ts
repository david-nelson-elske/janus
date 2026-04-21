/**
 * Default shell + nav components.
 *
 * These are the reference rendering pieces the framework uses when no
 * `layout` is provided to createApp. They're exported so consumers can
 * compose them (e.g. keep the default nav, wrap in a custom footer) rather
 * than rewrite from scratch.
 *
 * See ADR-124-12c for the layout-hook contract.
 */

import type { CompileResult, Identity } from '@janus/core';
import type { ComponentChildren, ComponentType, VNode } from 'preact';
import { h } from 'preact';
import { buildNavLinks } from './page-router';

export interface ShellProps {
  readonly children: ComponentChildren;
  readonly path: string;
  readonly identity: Identity;
  readonly registry: CompileResult;
}

/**
 * Default navigation — one link per entity that has a list binding.
 * Imported + composed by consumers who want the auto-derived entity nav
 * inside their own custom shell.
 */
export function DefaultNav({ registry }: { registry: CompileResult }): VNode {
  const links = buildNavLinks(registry);
  return h(
    'nav',
    { class: 'janus-nav' },
    h('div', { class: 'nav-brand' }, 'Janus'),
    h(
      'div',
      { class: 'nav-links' },
      ...links.map((link) => h('a', { href: link.href, class: 'nav-link' }, link.label)),
    ),
  );
}

/**
 * Default shell — `<nav>` + `<main>` around the entity component output.
 * The structure matches pre-12c behavior so apps without a consumer-provided
 * shell render byte-identical HTML.
 */
export function DefaultShell(props: ShellProps): VNode {
  return h(
    'div',
    { id: 'app' },
    h(DefaultNav, { registry: props.registry }),
    h('main', { class: 'janus-main' }, props.children),
  );
}

/**
 * Minimal shell — just `<div id="app"><main>…</main></div>` with no nav.
 * Used when `layout.suppressDefaultNav` is set without a full `layout.shell`.
 */
export function MinimalShell(props: ShellProps): VNode {
  return h('div', { id: 'app' }, h('main', { class: 'janus-main' }, props.children));
}

export type ShellComponent = ComponentType<ShellProps>;
