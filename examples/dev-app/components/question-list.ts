/**
 * QuestionList — List view for question entities.
 */

import { h } from 'preact';
import type { BindingContext } from '@janus/client';
import type { BindingConfig, EntityRecord, ReadPage } from '@janus/core';

export interface QuestionListProps {
  readonly contexts: readonly BindingContext[];
  readonly config: BindingConfig;
  readonly records?: readonly EntityRecord[];
  readonly page?: ReadPage;
}

export function QuestionList({ page }: QuestionListProps) {
  const records = page?.records ?? [];

  return h('div', { class: 'entity-list' },
    h('div', { class: 'entity-list-header' },
      h('h1', null, 'Questions'),
      h('span', { class: 'count' }, `${records.length} questions`),
    ),
    ...records.map((record) =>
      h('div', { class: 'entity-row', key: record.id },
        h('a', { href: `/questions/${record.id}` },
          h('strong', null, record.title as string),
        ),
        h('span', { class: `badge badge-${record.status}` }, String(record.status ?? '').replace(/_/g, ' ')),
      ),
    ),
  );
}
