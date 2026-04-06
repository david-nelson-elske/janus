/**
 * Demo app entities — tracks Janus framework development.
 *
 * These four entities exercise: Lifecycle, Relation, Enum, Markdown,
 * DateTime, Int, Str, Persistent storage, and lifecycle transitions.
 */

import { define } from '@janus/core';
import type { EntityStore, ReadPage } from '@janus/core';
import {
  Str,
  Int,
  Markdown,
  DateTime,
  Enum,
  Lifecycle,
  Relation,
  Persistent,
  Derived,
} from '@janus/vocabulary';

export const adr = define('adr', {
  schema: {
    number: Int({ required: true }),
    section: Str(),
    title: Str({ required: true }),
    summary: Markdown(),
    content: Markdown(),
    status: Lifecycle({
      draft: ['accepted'],
      accepted: ['implemented', 'superseded'],
      implemented: ['superseded'],
    }),
    parent: Relation('adr'),
    depends_on: Relation('adr'),
  },
  storage: Persistent(),
  description: 'Architecture decision records and sub-ADRs',
});

export const task = define('task', {
  schema: {
    title: Str({ required: true }),
    description: Markdown(),
    adr: Relation('adr'),
    assignee: Str(),
    priority: Enum(['low', 'medium', 'high']),
    heartbeat: DateTime(),
    status: Lifecycle({
      pending: ['in_progress', 'blocked'],
      in_progress: ['completed', 'blocked', 'pending'],
      blocked: ['pending', 'in_progress'],
    }),
  },
  storage: Persistent(),
  description: 'Implementation tasks linked to ADRs',
});

export const test_run = define('test_run', {
  schema: {
    suite: Str({ required: true }),
    passed: Int({ required: true }),
    failed: Int({ required: true }),
    skipped: Int(),
    duration: Int(),
    commit: Str(),
    timestamp: DateTime({ required: true }),
  },
  storage: Persistent(),
  description: 'Test suite execution records',
});

export const question = define('question', {
  schema: {
    title: Str({ required: true }),
    context: Markdown(),
    resolution: Markdown(),
    status: Lifecycle({
      open: ['resolved', 'deferred'],
      deferred: ['open'],
    }),
    adr: Relation('adr'),
  },
  storage: Persistent(),
  description: 'Open design questions linked to ADRs',
});

/**
 * task_summary — computed derived entity.
 *
 * Returns a single record summarizing task counts by status.
 * Agents can read this to understand project state at a glance.
 *
 * The compute function closes over a lazy store ref that gets
 * wired in the demo boot sequence.
 */
let _storeRef: EntityStore | null = null;

/** Wire the store into the task_summary compute function. Called by demo boot. */
export function wireTaskSummaryStore(store: EntityStore): void {
  _storeRef = store;
}

export const task_summary = define('task_summary', {
  schema: {
    total: Int({ required: true }),
    pending: Int({ required: true }),
    in_progress: Int({ required: true }),
    completed: Int({ required: true }),
    blocked: Int({ required: true }),
    high_priority: Int({ required: true }),
    with_assignee: Int({ required: true }),
  },
  storage: Derived({
    compute: async () => {
      const store = _storeRef;
      if (!store) return [];

      const page = await store.read('task', { limit: 1000 }) as ReadPage;
      const records = page.records;

      const summary = {
        id: '_derived:task_summary',
        _version: 1,
        createdAt: new Date().toISOString(),
        createdBy: 'system',
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
        total: records.length,
        pending: records.filter((r) => r.status === 'pending').length,
        in_progress: records.filter((r) => r.status === 'in_progress').length,
        completed: records.filter((r) => r.status === 'completed').length,
        blocked: records.filter((r) => r.status === 'blocked').length,
        high_priority: records.filter((r) => r.priority === 'high').length,
        with_assignee: records.filter((r) => r.assignee).length,
      };

      return [summary];
    },
  }),
  description: 'Computed summary of task counts by status — read-only, always current',
});

export const allDefinitions = [adr, task, test_run, question, task_summary];
