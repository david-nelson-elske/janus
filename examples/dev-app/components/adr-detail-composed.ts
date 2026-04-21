/**
 * AdrDetailComposed — Loader-driven detail view (ADR-124-12d example).
 *
 * Receives the composed `{ adr, questions }` payload from the binding's
 * loader instead of the framework's default single-entity read. Serves as
 * the reference for consumer apps that want a page built from multiple
 * reads on one binding.
 *
 * The sibling `adr-detail.ts` remains the reference for the default
 * context-based pattern (no loader).
 */

import { h } from 'preact';

interface AdrRecord {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly summary?: string;
  readonly content?: string;
  readonly status?: string;
}

interface QuestionRecord {
  readonly id: string;
  readonly title: string;
  readonly status?: string;
}

export interface AdrDetailComposedProps {
  readonly data?: {
    readonly adr: AdrRecord;
    readonly questions: readonly QuestionRecord[];
  };
}

export function AdrDetailComposed({ data }: AdrDetailComposedProps) {
  if (!data) return h('div', null, 'No ADR found');
  const { adr, questions } = data;

  return h('div', { class: 'detail-card' },
    h('a', { href: '/adrs', class: 'back-link' }, '\u2190 Back to ADRs'),
    h('div', { class: 'detail-header' },
      h('h1', null, `ADR-${adr.number}: ${adr.title}`),
      adr.status ? h('span', { class: `badge badge-${adr.status}` }, adr.status) : null,
    ),
    adr.summary ? h('div', { class: 'detail-field' },
      h('label', null, 'Summary'),
      h('div', { class: 'field-value richtext' }, adr.summary),
    ) : null,
    adr.content ? h('div', { class: 'detail-field' },
      h('label', null, 'Content'),
      h('div', { class: 'field-value richtext' }, adr.content),
    ) : null,
    // Composed data — questions linked to this ADR.
    h('div', { class: 'detail-field', 'data-test': 'linked-questions' },
      h('label', null, `Linked questions (${questions.length})`),
      questions.length === 0
        ? h('div', { class: 'text-muted' }, 'No linked questions.')
        : h('ul', null, ...questions.map((q) =>
            h('li', { key: q.id },
              h('a', { href: `/questions/${q.id}` }, q.title),
              q.status ? h('span', { class: `badge badge-${q.status}` }, ` ${q.status}`) : null,
            ),
          )),
    ),
  );
}
