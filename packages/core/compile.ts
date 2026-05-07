/**
 * compile() — Pure compilation from DeclarationRecord[] to CompileResult.
 *
 * No side effects, no IO. Deterministic output from input.
 * Performs the initiator join to build the dispatch index.
 *
 * This module is the BOOTSTRAP path. It takes in-memory DeclarationRecords (from consumer
 * function calls) and produces the initial dispatch index. The algorithms (initiator join,
 * partition, wiring validation) are stable and reusable, but the module will evolve:
 *
 * UPDATE @ M4+: Add a second input path — runtime recompilation from store. When core
 * tables (graph_node, participation, subscription, binding) are real entities persisted
 * in the database, compile() needs to also accept records read from the store. The join
 * and partition algorithms stay the same; the input source gains a second path. Likely
 * splits into bootstrapCompile() (from declarations) and recompile() (from store), both
 * calling shared assembleDispatchIndex() internals.
 */

import { isRelation, isReference, isMention, isSemanticField, isLifecycle, isWiringType, isTranslatableField } from '@janus/vocabulary';
import type { StorageStrategy, WiringEffects, RelationField, ReferenceField } from '@janus/vocabulary';

import type {
  AdapterKind,
  BindingIndex,
  BindingRecord,
  CapabilityRecord,
  CompileFilter,
  CompileResult,
  DeclarationRecord,
  FrozenPipeline,
  GraphNodeRecord,
  InitiatorConfig,
  QueryFieldRecord,
  ParticipationRecord,
  PipelineStage,
  RoutingRecord,
  SubscriptionRecord,
  WiringEdge,
  WiringIndex,
} from './types';
import { createHandlerContext } from './types';
import { OPERATORS_BY_TYPE } from './types';
import { resolveHandler } from './handler-registry';

// ── Helpers ─────────────────────────────────────────────────────

/** STABLE — dispatch index key format is an ADR-124 invariant. */
export function dispatchKey(initiator: string, entity: string, operation: string): string {
  return `${initiator}:${entity}:${operation}`;
}

/** Default adapter for each storage strategy mode. */
const DEFAULT_ADAPTER: Record<string, AdapterKind> = {
  persistent: 'relational',
  singleton: 'relational',
  volatile: 'memory',
  derived: 'derived',
  virtual: 'virtual',
};

/**
 * Resolve the adapter kind for a storage strategy.
 * Reads the `adapter` hint from the strategy if present (e.g., Persistent({ adapter: 'file' })),
 * otherwise falls back to the default for that mode.
 *
 * TODO: persist_routing should be a real Derived entity — browseable, modifiable at runtime,
 * triggering recompilation on change. Currently compile hardcodes the initial routing records
 * from storage strategy hints + defaults. When persist_routing becomes a proper entity (M4+),
 * this function should seed the initial records, but consumers and agents should be able to
 * override routing per-entity through the entity graph rather than only through storage hints.
 */
function adapterForStorage(storage: StorageStrategy): AdapterKind {
  const hint = (storage as { adapter?: string }).adapter;
  if (hint) return hint as AdapterKind;
  return DEFAULT_ADAPTER[storage.mode] ?? 'relational';
}

// ── Pipeline assembly ───────────────────────────────────────────

/**
 * STABLE — resolves Handler() keys to functions and wraps each as a PipelineStage closure
 * that injects participation config via prototypal inheritance. This is the core compile-time
 * resolution pattern from ADR 02.
 */
function assembleStages(
  participations: readonly ParticipationRecord[],
): readonly { order: number; transactional: boolean; stage: PipelineStage }[] {
  return participations.map((p) => {
    const entry = resolveHandler(p.handler);
    if (!entry) {
      throw new Error(`Unresolved handler '${p.handler}' for entity '${p.source}'`);
    }
    const fn = entry.fn;
    const config = p.config;

    // Each stage creates a scoped context with the handler's config,
    // runs the handler, then copies mutable fields back.
    const stage: PipelineStage = async (ctx) => {
      const { ctx: scoped, copyBack } = createHandlerContext(ctx, config);
      await fn(scoped);
      copyBack();
    };

    return { order: p.order, transactional: p.transactional, stage };
  });
}

/**
 * STABLE — the partition rule (sort by order, contiguous tx group, preTx/tx/postTx split)
 * is an ADR-03 invariant. Same algorithm regardless of where participation records come from.
 */
function partitionPipeline(
  stages: readonly { order: number; transactional: boolean; stage: PipelineStage }[],
): FrozenPipeline {
  // Sort by order (stable sort)
  const sorted = [...stages].sort((a, b) => a.order - b.order);

  if (sorted.length === 0) {
    return Object.freeze({ preTx: [], tx: [], postTx: [], needsTx: false });
  }

  // Find the transactional region
  const firstTxIdx = sorted.findIndex((s) => s.transactional);

  if (firstTxIdx === -1) {
    // No transactional stages — everything is preTx conceptually, but runs as flat postTx
    return Object.freeze({
      preTx: Object.freeze(sorted.map((s) => s.stage)),
      tx: Object.freeze([]),
      postTx: Object.freeze([]),
      needsTx: false,
    });
  }

  // Find last transactional stage
  let lastTxIdx = firstTxIdx;
  for (let i = sorted.length - 1; i >= firstTxIdx; i--) {
    if (sorted[i].transactional) {
      lastTxIdx = i;
      break;
    }
  }

  // Validate: no non-transactional stages between first and last transactional
  for (let i = firstTxIdx; i <= lastTxIdx; i++) {
    if (!sorted[i].transactional) {
      throw new Error(
        `Non-contiguous transaction group: non-transactional stage at order=${sorted[i].order} ` +
        `appears between transactional stages at order=${sorted[firstTxIdx].order} and order=${sorted[lastTxIdx].order}`,
      );
    }
  }

  const preTx = sorted.slice(0, firstTxIdx).map((s) => s.stage);
  const tx = sorted.slice(firstTxIdx, lastTxIdx + 1).map((s) => s.stage);
  const postTx = sorted.slice(lastTxIdx + 1).map((s) => s.stage);

  return Object.freeze({
    preTx: Object.freeze(preTx),
    tx: Object.freeze(tx),
    postTx: Object.freeze(postTx),
    needsTx: true,
  });
}

// ── Wiring index ────────────────────────────────────────────────

/**
 * Resolve the effective WiringEffects for a Relation or Reference field.
 * For Relation: if explicit `effects` provided, use that; else map `cascade` to `effects.deleted`.
 * For Reference: use `effects` if provided, else undefined.
 * Mentions have no effects.
 */
function resolveEffects(wiring: RelationField | ReferenceField): WiringEffects | undefined {
  if (isRelation(wiring)) {
    const rel = wiring as RelationField;
    if (rel.effects) return rel.effects;
    // Backward compat: map cascade field to effects.deleted
    return { deleted: rel.cascade };
  }
  if (isReference(wiring)) {
    return (wiring as ReferenceField).effects;
  }
  return undefined;
}

/**
 * Validate cascade chains don't form cycles (DFS on cascade adjacency).
 * Throws CircularCascadeError if a cycle is detected.
 */
function validateCascadeChains(edges: readonly WiringEdge[]): void {
  // Build adjacency: when entity X is deleted and cascades, it deletes entities that reference X.
  // So the cascade propagation graph is: targetEntity -> sourceEntities (where effect is cascade).
  const cascadeAdj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.effects?.deleted === 'cascade') {
      let list = cascadeAdj.get(e.to);
      if (!list) {
        list = [];
        cascadeAdj.set(e.to, list);
      }
      list.push(e.from);
    }
  }

  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(node: string): void {
    if (stack.has(node)) {
      throw new Error(`Circular cascade chain detected involving entity '${node}'`);
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    for (const next of cascadeAdj.get(node) ?? []) {
      dfs(next);
    }
    stack.delete(node);
  }

  for (const node of cascadeAdj.keys()) {
    dfs(node);
  }
}

/**
 * Validate transition effects: { transition: 'X' } actions require the SOURCE entity
 * (the one being transitioned) to have a lifecycle, and X must be a reachable state.
 */
function validateTransitionEffects(edges: readonly WiringEdge[], graphNodes: Map<string, GraphNodeRecord>): void {
  for (const edge of edges) {
    const transitioned = edge.effects?.transitioned;
    if (!transitioned) continue;

    for (const [, action] of Object.entries(transitioned)) {
      if (typeof action !== 'object' || !action.transition) continue;

      const targetState = action.transition;
      const sourceNode = graphNodes.get(edge.from);
      if (!sourceNode) continue;

      if (sourceNode.lifecycles.length === 0) {
        throw new Error(
          `Invalid transition effect on '${edge.from}.${edge.fromField}': ` +
          `action { transition: '${targetState}' } requires entity '${edge.from}' to have a lifecycle field, but it has none`,
        );
      }

      // transitionTargets is already derived by define() — reuse it
      const reachable = sourceNode.transitionTargets.some((t) => t.to === targetState);
      if (!reachable) {
        throw new Error(
          `Unreachable transition effect on '${edge.from}.${edge.fromField}': ` +
          `state '${targetState}' is not a valid transition target in entity '${edge.from}'`,
        );
      }
    }
  }
}

/**
 * Validate no conflicting effect policies on the same trigger for the same target entity.
 * E.g., restrict + cascade on deleted from different source fields → error.
 */
function validateNoConflictingEffects(edges: readonly WiringEdge[]): void {
  // Group by target entity
  const byTarget = new Map<string, WiringEdge[]>();
  for (const edge of edges) {
    if (!edge.effects?.deleted) continue;
    let list = byTarget.get(edge.to);
    if (!list) {
      list = [];
      byTarget.set(edge.to, list);
    }
    list.push(edge);
  }

  for (const [target, targetEdges] of byTarget) {
    const policies = new Set(targetEdges.map((e) => e.effects!.deleted!));
    if (policies.has('restrict') && policies.has('cascade')) {
      const restrictEdge = targetEdges.find((e) => e.effects!.deleted === 'restrict')!;
      const cascadeEdge = targetEdges.find((e) => e.effects!.deleted === 'cascade')!;
      throw new Error(
        `Conflicting delete effects on entity '${target}': ` +
        `'${restrictEdge.from}.${restrictEdge.fromField}' uses 'restrict' but ` +
        `'${cascadeEdge.from}.${cascadeEdge.fromField}' uses 'cascade'. ` +
        `These cannot coexist — restrict blocks the delete while cascade requires it to proceed`,
      );
    }
  }
}

function buildWiringIndex(graphNodes: Map<string, GraphNodeRecord>): WiringIndex {
  const edges: WiringEdge[] = [];

  for (const [, node] of graphNodes) {
    for (const { field, wiring } of node.wiringFields) {
      if (isRelation(wiring)) {
        const target = wiring.target as string;
        if (!graphNodes.has(target)) {
          throw new Error(
            `Entity '${node.name}' field '${field}' references unknown entity '${target}'`,
          );
        }
        const effects = resolveEffects(wiring);
        edges.push({ from: node.name, fromField: field, to: target, kind: 'relation', effects });
      } else if (isReference(wiring)) {
        const target = wiring.target as string;
        if (!graphNodes.has(target)) {
          throw new Error(
            `Entity '${node.name}' field '${field}' references unknown entity '${target}'`,
          );
        }
        const effects = resolveEffects(wiring);
        edges.push({ from: node.name, fromField: field, to: target, kind: 'reference', effects });
      } else if (isMention(wiring)) {
        const allowed = wiring.allowed ?? [];
        for (const target of allowed) {
          if (!graphNodes.has(target)) {
            throw new Error(
              `Entity '${node.name}' field '${field}' mentions unknown entity '${target}'`,
            );
          }
          edges.push({ from: node.name, fromField: field, to: target, kind: 'mention' });
        }
      }
    }
  }

  // Validate: no circular cascade chains
  validateCascadeChains(edges);

  // Validate: transition effects target entities with lifecycles and reachable states
  validateTransitionEffects(edges, graphNodes);

  // Validate: no conflicting effect policies on same trigger for same target
  validateNoConflictingEffects(edges);

  const frozenEdges = Object.freeze(edges);

  // Collect into mutable buckets, then freeze once into the final maps
  const outboundBuckets = new Map<string, WiringEdge[]>();
  const inboundBuckets = new Map<string, WiringEdge[]>();
  const reverseEffectsBuckets = new Map<string, WiringEdge[]>();

  for (const e of frozenEdges) {
    let out = outboundBuckets.get(e.from);
    if (!out) { out = []; outboundBuckets.set(e.from, out); }
    out.push(e);

    let inp = inboundBuckets.get(e.to);
    if (!inp) { inp = []; inboundBuckets.set(e.to, inp); }
    inp.push(e);

    if (e.effects && (e.effects.deleted || e.effects.transitioned)) {
      let rev = reverseEffectsBuckets.get(e.to);
      if (!rev) { rev = []; reverseEffectsBuckets.set(e.to, rev); }
      rev.push(e);
    }
  }

  const outboundMap = new Map<string, readonly WiringEdge[]>();
  for (const [k, v] of outboundBuckets) outboundMap.set(k, Object.freeze(v));
  const inboundMap = new Map<string, readonly WiringEdge[]>();
  for (const [k, v] of inboundBuckets) inboundMap.set(k, Object.freeze(v));
  const reverseEffectsMap = new Map<string, readonly WiringEdge[]>();
  for (const [k, v] of reverseEffectsBuckets) reverseEffectsMap.set(k, Object.freeze(v));

  const EMPTY: readonly WiringEdge[] = Object.freeze([]);

  return Object.freeze({
    edges: frozenEdges,
    outbound(entity: string) {
      return outboundMap.get(entity) ?? EMPTY;
    },
    inbound(entity: string) {
      return inboundMap.get(entity) ?? EMPTY;
    },
    reverseEffects(entity: string) {
      return reverseEffectsMap.get(entity) ?? EMPTY;
    },
  });
}

// ── Query fields ────────────────────────────────────────────────

const DEFAULT_OPERATORS: readonly string[] = Object.freeze(['eq', 'ne', 'null']);

function buildQueryFields(entity: string, graphNodes: Map<string, GraphNodeRecord>): readonly QueryFieldRecord[] {
  const node = graphNodes.get(entity);
  if (!node) return Object.freeze([]);

  const fields: QueryFieldRecord[] = [];
  for (const [name, def] of Object.entries(node.schema)) {
    let type: string;
    let operators: readonly string[];
    let required = false;
    let translatable = false;

    // Translatable fields wrap a base semantic field. For the query layer
    // they behave like the base — same operators, same required flag — but
    // we surface a `translatable` marker so downstream tooling (e.g. agent
    // tool descriptors) can render lang-aware UI.
    const inner = isTranslatableField(def) ? def.base : def;
    if (isTranslatableField(def)) translatable = true;

    if (isSemanticField(inner)) {
      type = inner.kind;
      operators = OPERATORS_BY_TYPE[inner.kind] ?? DEFAULT_OPERATORS;
      required = !!inner.hints?.required;
    } else if (isLifecycle(inner)) {
      type = 'lifecycle';
      operators = OPERATORS_BY_TYPE.lifecycle ?? DEFAULT_OPERATORS;
    } else if (isWiringType(inner)) {
      type = inner.kind;
      operators = OPERATORS_BY_TYPE[inner.kind] ?? DEFAULT_OPERATORS;
    } else {
      type = 'unknown';
      operators = DEFAULT_OPERATORS;
    }

    fields.push(
      Object.freeze({ entity, field: name, type, operators, required, translatable }),
    );
  }

  return Object.freeze(fields);
}

// ── Binding index ──────────────────────────────────────────────

function buildBindingIndex(allBindings: readonly BindingRecord[]): BindingIndex {
  // Collect into plain arrays, then freeze once into the final maps
  const entityBuckets = new Map<string, BindingRecord[]>();
  const viewBuckets = new Map<string, BindingRecord[]>();
  const byPairMap = new Map<string, BindingRecord>();

  for (const b of allBindings) {
    let entityList = entityBuckets.get(b.source);
    if (!entityList) {
      entityList = [];
      entityBuckets.set(b.source, entityList);
    }
    entityList.push(b);

    let viewList = viewBuckets.get(b.view);
    if (!viewList) {
      viewList = [];
      viewBuckets.set(b.view, viewList);
    }
    viewList.push(b);

    byPairMap.set(`${b.source}:${b.view}`, b);
  }

  // Build frozen lookup maps in one pass
  const byEntityMap = new Map<string, readonly BindingRecord[]>();
  for (const [k, v] of entityBuckets) byEntityMap.set(k, Object.freeze(v));
  const byViewMap = new Map<string, readonly BindingRecord[]>();
  for (const [k, v] of viewBuckets) byViewMap.set(k, Object.freeze(v));

  const EMPTY: readonly BindingRecord[] = Object.freeze([]);

  return Object.freeze({
    byEntity(entity: string) {
      return byEntityMap.get(entity) ?? EMPTY;
    },
    byView(view: string) {
      return byViewMap.get(view) ?? EMPTY;
    },
    byEntityAndView(entity: string, view: string) {
      return byPairMap.get(`${entity}:${view}`);
    },
  });
}

// ── compile() ───────────────────────────────────────────────────

export function compile(
  declarations: readonly DeclarationRecord[],
  initiators?: readonly InitiatorConfig[],
  filter?: CompileFilter,
): CompileResult {
  const compileStart = performance.now();
  // ── Phase 1: Collect ────────────────────────────────────────
  // BOOTSTRAP PATH: reads from in-memory DeclarationRecord[] (consumer function calls).
  // UPDATE @ M4+: Add store-backed path that reads from persisted core table entities
  // (graph_node, participation, subscription, binding) for runtime recompilation.

  const graphNodes = new Map<string, GraphNodeRecord>();
  const allParticipations: ParticipationRecord[] = [];
  const allSubscriptions: SubscriptionRecord[] = [];
  const allBindings: BindingRecord[] = [];
  const capabilities = new Map<string, CapabilityRecord>();
  const allDrops = new Set<string>();

  for (const decl of declarations) {
    switch (decl.kind) {
      case 'define': {
        const { name } = decl.record;
        if (graphNodes.has(name)) {
          throw new Error(`Duplicate entity name: '${name}'`);
        }
        graphNodes.set(name, decl.record);
        break;
      }
      case 'participate':
        allParticipations.push(...decl.records);
        break;
      case 'capability': {
        const { name } = decl.record;
        if (capabilities.has(name)) {
          throw new Error(`Duplicate capability name: '${name}'`);
        }
        capabilities.set(name, decl.record);
        break;
      }
      case 'subscribe':
        allSubscriptions.push(...decl.records);
        break;
      case 'bind':
        allBindings.push(...decl.records);
        break;
      case 'drop':
        allDrops.add(decl.entity);
        break;
    }
  }

  // ── Phase 2: Validate ───────────────────────────────────────

  // Validate participation sources exist
  const initiatorNames = new Set<string>(['system', ...(initiators ?? []).map((i) => i.name)]);
  for (const p of allParticipations) {
    if (!graphNodes.has(p.source) && !initiatorNames.has(p.source)) {
      throw new Error(`Participation references unknown entity: '${p.source}'`);
    }
  }

  // Validate handler keys
  for (const p of allParticipations) {
    if (!resolveHandler(p.handler)) {
      throw new Error(`Participation for '${p.source}' references unresolved handler: '${p.handler}'`);
    }
  }

  // Validate capability concern configs. Catches typos and impossible
  // values at compile time so users discover mistakes before dispatch.
  for (const cap of capabilities.values()) {
    if (cap.policy) {
      if (!Array.isArray(cap.policy.rules)) {
        throw new Error(`Capability '${cap.name}' policy.rules must be an array`);
      }
      for (const [i, rule] of cap.policy.rules.entries()) {
        if (!rule.role || typeof rule.role !== 'string') {
          throw new Error(
            `Capability '${cap.name}' policy.rules[${i}].role must be a non-empty string`,
          );
        }
        if (rule.operations !== '*' && !Array.isArray(rule.operations)) {
          throw new Error(
            `Capability '${cap.name}' policy.rules[${i}].operations must be '*' or an array`,
          );
        }
      }
    }
    if (cap.rateLimit) {
      if (!Number.isFinite(cap.rateLimit.max) || cap.rateLimit.max <= 0) {
        throw new Error(
          `Capability '${cap.name}' rateLimit.max must be a positive number`,
        );
      }
      if (!Number.isFinite(cap.rateLimit.window) || cap.rateLimit.window <= 0) {
        throw new Error(
          `Capability '${cap.name}' rateLimit.window must be a positive number (milliseconds)`,
        );
      }
    }
    if (cap.timeout !== undefined) {
      if (!Number.isFinite(cap.timeout) || cap.timeout <= 0) {
        throw new Error(
          `Capability '${cap.name}' timeout must be a positive number (milliseconds)`,
        );
      }
    }
  }

  // Build wiring index (validates wiring targets)
  const wiring = buildWiringIndex(graphNodes);

  // Validate QrCode expiresWith references
  for (const [, node] of graphNodes) {
    for (const [fieldName, fieldDef] of Object.entries(node.schema)) {
      if (!isSemanticField(fieldDef) || fieldDef.kind !== 'qrcode') continue;
      const expiresWith = (fieldDef.hints as { expiresWith?: string })?.expiresWith;
      if (!expiresWith) continue;

      const targetField = node.schema[expiresWith];
      if (!targetField) {
        throw new Error(
          `Entity '${node.name}': QrCode field '${fieldName}' references expiresWith='${expiresWith}', but that field does not exist`,
        );
      }
      if (!isSemanticField(targetField) || targetField.kind !== 'datetime') {
        const actualKind = isSemanticField(targetField) ? targetField.kind : 'non-semantic';
        throw new Error(
          `Entity '${node.name}': QrCode field '${fieldName}' references expiresWith='${expiresWith}', but that field is '${actualKind}', not 'datetime'`,
        );
      }
    }
  }

  // Index participations by source (used in Phase 4 and query helpers)
  const participationsBySource = new Map<string, ParticipationRecord[]>();
  for (const p of allParticipations) {
    let list = participationsBySource.get(p.source);
    if (!list) {
      list = [];
      participationsBySource.set(p.source, list);
    }
    list.push(p);
  }

  // ── Phase 3: Generate persist_routing ───────────────────────

  const persistRouting: RoutingRecord[] = [];
  for (const [, node] of graphNodes) {
    persistRouting.push(
      Object.freeze({
        entity: node.name,
        table: node.name,
        adapter: adapterForStorage(node.storage),
        schema: node.schema,
        storage: node.storage,
        indexes: node.indexes,
        evolve: node.evolve,
      }),
    );
  }

  // ── Phase 4: Build dispatch index ───────────────────────────
  // STABLE — the initiator join algorithm is an ADR-03 invariant. Works the same
  // whether records come from Phase 1 (bootstrap) or from the store (recompile).

  const dispatchIndex = new Map<string, FrozenPipeline>();

  // Collect initiators: system + consumer-defined
  const systemInitiator: InitiatorConfig = { name: 'system', origin: 'framework', participations: [] };
  const allInitiatorConfigs = [systemInitiator, ...(initiators ?? [])];
  const initiatorsMap = new Map<string, InitiatorConfig>();
  for (const i of allInitiatorConfigs) {
    initiatorsMap.set(i.name, i);
  }

  const allInitiators = allInitiatorConfigs.map((i) => ({
    name: i.name,
    participations: i.participations ?? [],
  }));

  for (const initiator of allInitiators) {
    // Apply initiator filter
    if (filter?.initiator && initiator.name !== filter.initiator) continue;

    // Initiator's own participations
    const initiatorParts = [
      ...initiator.participations,
      ...(participationsBySource.get(initiator.name) ?? []),
    ];

    for (const [entityName, node] of graphNodes) {
      // Apply entity filter
      if (filter?.entity && entityName !== filter.entity) continue;
      // Get entity's participations
      const entityParts = participationsBySource.get(entityName) ?? [];

      for (const operation of node.operations) {
        // Filter entity participations to this operation
        const filteredEntityParts = entityParts.filter(
          (p) => !p.operations || p.operations.includes(operation),
        );

        // Also filter initiator participations
        const filteredInitiatorParts = initiatorParts.filter(
          (p) => !p.operations || p.operations.includes(operation),
        );

        // Apply handler filter
        let allParts = [...filteredInitiatorParts, ...filteredEntityParts];
        if (filter?.handler) {
          // Only build pipelines that include this handler
          if (!allParts.some((p) => p.handler === filter.handler)) continue;
        }

        if (allParts.length === 0) continue;

        const stages = assembleStages(allParts);
        const pipeline = partitionPipeline(stages);

        dispatchIndex.set(dispatchKey(initiator.name, entityName, operation), pipeline);
      }

      // Also build pipelines for transition targets (they use the 'update' pipeline)
      for (const target of node.transitionTargets) {
        const key = dispatchKey(initiator.name, entityName, target.name);
        // Transition targets reuse the update pipeline
        const updateKey = dispatchKey(initiator.name, entityName, 'update');
        const updatePipeline = dispatchIndex.get(updateKey);
        if (updatePipeline) {
          dispatchIndex.set(key, updatePipeline);
        }
      }

      // Build pipelines for custom actions (ADR 07c)
      const actionRecords = entityParts.filter((p) => p.config.actionName);
      for (const actionRec of actionRecords) {
        const actionName = actionRec.config.actionName as string;

        // Include this action's handler + universal handlers (no ops filter, not other actions)
        const actionEntityParts = entityParts.filter((p) =>
          (p.config.actionName === actionName) ||
          (!p.operations && !p.config.actionName),
        );

        const actionInitiatorParts = initiatorParts.filter(
          (p) => !p.operations && !p.config.actionName,
        );

        let actionParts = [...actionInitiatorParts, ...actionEntityParts];
        if (filter?.handler) {
          if (!actionParts.some((p) => p.handler === filter.handler)) continue;
        }
        if (actionParts.length === 0) continue;

        const stages = assembleStages(actionParts);
        const pipeline = partitionPipeline(stages);
        dispatchIndex.set(dispatchKey(initiator.name, entityName, actionName), pipeline);
      }
    }
  }

  // ── Build result ────────────────────────────────────────────

  const compilationDuration = performance.now() - compileStart;

  const result: CompileResult = {
    graphNodes,
    participations: Object.freeze([...allParticipations]),
    subscriptions: Object.freeze([...allSubscriptions]),
    bindings: Object.freeze([...allBindings]),
    capabilities,
    dispatchIndex,
    initiators: initiatorsMap,
    persistRouting: Object.freeze(persistRouting),
    drops: Object.freeze(allDrops),
    wiring,
    bindingIndex: buildBindingIndex(allBindings),
    compiledAt: new Date().toISOString(),
    compilationDuration,

    pipeline(initiator: string, entity: string, operation: string) {
      return dispatchIndex.get(dispatchKey(initiator, entity, operation));
    },

    entity(name: string) {
      return graphNodes.get(name);
    },

    capability(name: string) {
      return capabilities.get(name);
    },

    participationsFor(entity: string) {
      return Object.freeze(participationsBySource.get(entity) ?? []);
    },

    operationsFor(entity: string) {
      const node = graphNodes.get(entity);
      return node ? node.operations : Object.freeze([]);
    },

    queryFields(entity: string) {
      return buildQueryFields(entity, graphNodes);
    },
  };

  return result;
}
