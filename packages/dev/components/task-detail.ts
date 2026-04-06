/**
 * TaskDetail — Detail view for a single task entity.
 *
 * Shows all fields with their binding config. Editable fields render as inputs.
 */

import { h } from 'preact';
import type { BindingContext } from '@janus/client';
import type { BindingConfig } from '@janus/core';
import { renderField } from './field-renderers';

export interface TaskDetailProps {
  readonly context: BindingContext;
  readonly config: BindingConfig;
}

export function TaskDetail({ context, config }: TaskDetailProps) {
  if (!context) return h('div', null, 'No task found');

  const fields = config.fields ?? {};

  return h('div', { class: 'detail-card' },
    h('a', { href: '/tasks', class: 'back-link' }, '\u2190 Back to tasks'),
    h('div', { class: 'detail-header' },
      context.fields.title
        ? renderField(context.fields.title, fields.title?.component)
        : h('h1', null, 'Task'),
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
