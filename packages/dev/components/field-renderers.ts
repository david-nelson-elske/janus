/**
 * Field renderers — Preact components for rendering entity fields.
 *
 * Maps FieldBindingConfig.component hints to component implementations.
 * These read signal values directly for SSR (server-rendered to static HTML).
 */

import { h } from 'preact';
import type { FieldState } from '@janus/client';

/** Editable heading — renders as h1 with the field value. */
export function EditableHeading({ field }: { field: FieldState<string> }) {
  return h('h1', null, field.committed.value ?? '');
}

/** Status/priority badge with color coding. */
export function StatusBadge({ field }: { field: FieldState<string> }) {
  const value = field.committed.value ?? '';
  return h('span', { class: `badge badge-${value}` }, value.replace(/_/g, ' '));
}

/** Read-only text display. */
export function TextDisplay({ field }: { field: FieldState<string> }) {
  return h('span', { class: 'field-value' }, field.committed.value ?? '—');
}

/** Markdown/richtext field — renders as plain text for SSR (no markdown parser). */
export function RichText({ field }: { field: FieldState<string> }) {
  const value = field.committed.value ?? '';
  if (!value) return h('span', { class: 'field-value text-muted' }, '—');
  return h('div', { class: 'field-value richtext' }, value);
}

/** Registry mapping component hints to Preact components. */
export const fieldRenderers: Record<string, (props: { field: FieldState }) => any> = {
  heading: EditableHeading as any,
  badge: StatusBadge as any,
  richtext: RichText as any,
  text: TextDisplay as any,
};

/** Render a field based on its binding config component hint. */
export function renderField(field: FieldState, componentHint?: string) {
  const Renderer = componentHint ? fieldRenderers[componentHint] : undefined;
  if (Renderer) {
    return h(Renderer, { field });
  }
  // Default: plain text
  return h('span', { class: 'field-value' }, String(field.committed.value ?? '—'));
}
