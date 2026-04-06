/**
 * Agent context utilities — buildAgentContext(), discoverTools(), deriveInteractionLevels().
 *
 * Pure functions that read from the compiled registry to produce agent-consumable
 * data structures. No side effects, no dispatch.
 */

import type {
  AgentInteractionLevel,
  CompileResult,
  Operation,
  QueryFieldRecord,
  TransitionTarget,
} from '@janus/core';
import { isSemanticField } from '@janus/vocabulary';
import type { Sensitivity } from '@janus/vocabulary';
import type {
  AgentSessionContext,
  FocusedEntityContext,
  SessionBindingEntry,
  SessionRecord,
  ToolDescriptor,
  ToolFieldDescriptor,
} from './types';

// ── Interaction level derivation ───────────────────────────────

function sensitivityToLevel(sensitivity: Sensitivity): AgentInteractionLevel {
  switch (sensitivity) {
    case 'open': return 'read-write';
    case 'standard': return 'read';
    case 'restricted': return 'aware';
  }
}

/**
 * Derive per-field agent interaction levels for an entity.
 *
 * Defaults from GraphNodeRecord.sensitivity, overridden by binding config
 * when a binding exists for the entity (optionally filtered by view).
 */
export function deriveInteractionLevels(
  registry: CompileResult,
  entity: string,
  view?: string,
): Readonly<Record<string, AgentInteractionLevel>> {
  const node = registry.entity(entity);
  if (!node) return Object.freeze({});

  const defaultLevel = sensitivityToLevel(node.sensitivity);
  const levels: Record<string, AgentInteractionLevel> = {};

  for (const fieldName of Object.keys(node.schema)) {
    levels[fieldName] = defaultLevel;
  }

  const bindings = view
    ? [registry.bindingIndex.byEntityAndView(entity, view)].filter(Boolean)
    : registry.bindingIndex.byEntity(entity);

  if (bindings.length > 0) {
    const fields = bindings[0].config.fields;
    if (fields) {
      for (const [field, config] of Object.entries(fields)) {
        if (config.agent) {
          levels[field] = config.agent;
        }
      }
    }
  }

  return Object.freeze(levels);
}

// ── Tool discovery ─────────────────────────────────────────────

function fieldTypeString(field: unknown): string {
  if (isSemanticField(field)) return field.kind;
  return 'unknown';
}

/**
 * Discover available tools for an agent by querying the dispatch index.
 *
 * Returns ToolDescriptor[] describing what operations the agent can perform,
 * filtered to consumer-origin entities only.
 */
export function discoverTools(
  registry: CompileResult,
  initiator: string,
): readonly ToolDescriptor[] {
  const tools: ToolDescriptor[] = [];
  const seen = new Set<string>();

  // Cache per-entity data (fields, transitions) shared across operations
  const entityCache = new Map<string, {
    fields: readonly ToolFieldDescriptor[];
    transitions: readonly string[];
    description?: string;
  }>();

  for (const key of registry.dispatchIndex.keys()) {
    const parts = key.split(':');
    if (parts.length < 3) continue;

    const keyInitiator = parts[0];
    if (keyInitiator !== initiator) continue;

    const entity = parts[1];
    const operation = parts[2];

    const node = registry.entity(entity);
    if (!node || node.origin === 'framework') continue;

    const dedup = `${entity}:${operation}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    let cached = entityCache.get(entity);
    if (!cached) {
      const levels = deriveInteractionLevels(registry, entity);
      const queryFields = registry.queryFields(entity);
      const queryFieldMap = new Map<string, QueryFieldRecord>();
      for (const qf of queryFields) {
        queryFieldMap.set(qf.field, qf);
      }

      const fields: ToolFieldDescriptor[] = [];
      for (const [fieldName, fieldDef] of Object.entries(node.schema)) {
        const qf = queryFieldMap.get(fieldName);
        fields.push({
          name: fieldName,
          type: fieldTypeString(fieldDef),
          required: qf?.required ?? false,
          interactionLevel: levels[fieldName] ?? 'read',
          ...(qf?.operators.length ? { operators: qf.operators } : {}),
        });
      }

      const transitions = node.transitionTargets.map((t) => t.name);

      cached = {
        fields: Object.freeze(fields),
        transitions: Object.freeze(transitions),
        description: node.description,
      };
      entityCache.set(entity, cached);
    }

    tools.push({
      entity,
      operation,
      description: cached.description,
      fields: cached.fields,
      ...(cached.transitions.length > 0 ? { transitions: cached.transitions } : {}),
    });
  }

  return Object.freeze(tools);
}

// ── Agent context building ─────────────────────────────────────

export interface BuildAgentContextConfig {
  readonly registry: CompileResult;
  readonly session: SessionRecord;
  readonly initiator: string;
}

/**
 * Build an AgentSessionContext from a session record and the compiled registry.
 *
 * Resolves the focused entity from session.latest_binding_entity/view,
 * derives interaction levels, and collects available operations.
 */
export function buildAgentContext(config: BuildAgentContextConfig): AgentSessionContext {
  const { registry, session, initiator } = config;

  // Resolve focused entity
  let focusedEntity: FocusedEntityContext | undefined;

  if (session.latest_binding_entity) {
    const entity = session.latest_binding_entity;
    const view = session.latest_binding_view ?? 'detail';
    const node = registry.entity(entity);

    if (node) {
      const fieldAccess = deriveInteractionLevels(registry, entity, view);

      // Collect operations available through this initiator
      const operations: Operation[] = [];
      for (const op of node.operations) {
        if (registry.pipeline(initiator, entity, op)) {
          operations.push(op);
        }
      }

      // Collect transition targets
      const transitions = node.transitionTargets
        .filter((t: TransitionTarget) => registry.pipeline(initiator, entity, t.name))
        .map((t: TransitionTarget) => t.name);

      focusedEntity = Object.freeze({
        entity,
        view,
        operations: Object.freeze(operations),
        transitions: Object.freeze(transitions),
        fieldAccess,
      });
    }
  }

  // Resolve active bindings
  const activeBindings: SessionBindingEntry[] = [];

  if (session.active_bindings && Array.isArray(session.active_bindings)) {
    for (const binding of session.active_bindings) {
      if (binding && typeof binding === 'object' && 'entity' in binding && 'view' in binding) {
        const b = binding as { entity: string; view: string };
        const fieldAccess = deriveInteractionLevels(registry, b.entity, b.view);
        activeBindings.push(Object.freeze({
          entity: b.entity,
          view: b.view,
          fieldAccess,
        }));
      }
    }
  }

  return Object.freeze({
    session,
    focusedEntity,
    activeBindings: Object.freeze(activeBindings),
  });
}
