/**
 * QuestionDetail — Detail view for a question entity.
 */

import { h } from 'preact';
import type { BindingContext } from '@janus/client';
import type { BindingConfig } from '@janus/core';
import { renderField } from './field-renderers';

export interface QuestionDetailProps {
  readonly context: BindingContext;
  readonly config: BindingConfig;
}

export function QuestionDetail({ context, config }: QuestionDetailProps) {
  if (!context) return h('div', null, 'No question found');

  const fields = config.fields ?? {};

  return h('div', { class: 'detail-card' },
    h('a', { href: '/questions', class: 'back-link' }, '\u2190 Back to questions'),
    h('div', { class: 'detail-header' },
      context.fields.title
        ? renderField(context.fields.title, fields.title?.component)
        : h('h1', null, 'Question'),
    ),
    ...Object.entries(fields)
      .filter(([name]) => name !== 'title' && context.fields[name])
      .map(([name, fieldConfig]) =>
        h('div', { class: 'detail-field', key: name },
          h('label', null, fieldConfig.label ?? name),
          renderField(context.fields[name], fieldConfig.component),
        ),
      ),
  );
}
