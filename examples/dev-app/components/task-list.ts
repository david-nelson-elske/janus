/**
 * TaskList — List view for task entities.
 *
 * Shows tasks in a table with columns: title, status, priority, assignee.
 * Each row links to the detail view.
 */

import { h } from 'preact';
import type { BindingContext } from '@janus/client';
import type { BindingConfig, EntityRecord, ReadPage } from '@janus/core';

export interface TaskListProps {
  readonly contexts: readonly BindingContext[];
  readonly config: BindingConfig;
  readonly records?: readonly EntityRecord[];
  readonly page?: ReadPage;
}

export function TaskList({ page }: TaskListProps) {
  const records = page?.records ?? [];

  return h('div', { class: 'entity-list' },
    h('div', { class: 'entity-list-header' },
      h('h1', null, 'Tasks'),
      h('span', { class: 'count' }, `${records.length} tasks`),
    ),
    ...records.map((record) =>
      h('div', { class: 'entity-row', key: record.id },
        h('a', { href: `/tasks/${record.id}` },
          h('strong', null, record.title as string),
        ),
        h('span', { class: `badge badge-${record.status}` }, String(record.status ?? '').replace(/_/g, ' ')),
        h('span', { class: `badge badge-${record.priority}` }, String(record.priority ?? '')),
        h('span', { class: 'assignee' }, (record.assignee as string) || '—'),
      ),
    ),
  );
}
