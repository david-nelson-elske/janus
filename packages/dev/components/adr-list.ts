/**
 * AdrList — Dashboard view for ADR entities.
 *
 * Shows status counts in a dashboard grid, plus a list of all ADRs.
 */

import { h } from 'preact';
import type { BindingContext } from '@janus/client';
import type { BindingConfig, EntityRecord, ReadPage } from '@janus/core';

export interface AdrListProps {
  readonly contexts: readonly BindingContext[];
  readonly config: BindingConfig;
  readonly records?: readonly EntityRecord[];
  readonly page?: ReadPage;
}

export function AdrList({ page }: AdrListProps) {
  const records = page?.records ?? [];

  // Count by status
  const counts: Record<string, number> = {};
  for (const r of records) {
    const status = String(r.status ?? 'unknown');
    counts[status] = (counts[status] ?? 0) + 1;
  }

  return h('div', null,
    h('div', { class: 'entity-list-header' },
      h('h1', null, 'ADR Dashboard'),
      h('span', { class: 'count' }, `${records.length} ADRs`),
    ),
    // Dashboard grid
    h('div', { class: 'dashboard-grid' },
      ...Object.entries(counts).map(([status, count]) =>
        h('div', { class: 'dashboard-card', key: status },
          h('div', { class: 'count' }, String(count)),
          h('div', { class: `label badge badge-${status}` }, status),
        ),
      ),
    ),
    // ADR list
    h('div', { class: 'entity-list' },
      ...records.map((record) =>
        h('div', { class: 'entity-row', key: record.id },
          h('a', { href: `/adrs/${record.id}` },
            h('strong', null, `ADR-${record.number}`),
            h('span', { style: 'margin-left: 0.5rem; color: #a1a1aa;' }, record.title as string),
          ),
          h('span', { class: `badge badge-${record.status}` }, String(record.status ?? '')),
        ),
      ),
    ),
  );
}
