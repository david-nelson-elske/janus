/**
 * BindingRegistry — Agent-visible inventory of active binding contexts.
 *
 * Tracks which binding contexts are active on the current page.
 * Updated on navigation, read by the agent harness.
 */

import type { BindingContext } from './binding-context';

export interface BindingRegistry {
  getActiveContexts(): readonly BindingContext[];
  setActiveContexts(contexts: readonly BindingContext[]): void;
  clearActiveContexts(): void;
  onContextsChanged(fn: () => void): () => void;
}

export function createBindingRegistry(): BindingRegistry {
  let contexts: readonly BindingContext[] = [];
  const listeners = new Set<() => void>();

  function notify() {
    for (const fn of listeners) fn();
  }

  return {
    getActiveContexts() {
      return contexts;
    },

    setActiveContexts(newContexts) {
      contexts = Object.freeze([...newContexts]);
      notify();
    },

    clearActiveContexts() {
      contexts = Object.freeze([]);
      notify();
    },

    onContextsChanged(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
