/**
 * Types for the M9 Agent Surface.
 */

import type { AgentInteractionLevel, Identity, Operation } from '@janus/core';

// ── Surface config ─────────────────────────────────────────────

export interface AgentSurfaceConfig {
  readonly name?: string;
  readonly identity?: {
    readonly agents?: Readonly<Record<string, Identity>>;
  };
}

// ── Agent response (written to ctx.extensions.agentResponse) ───

export interface AgentResponse {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly meta?: {
    readonly entity: string;
    readonly operation: string;
    readonly interactionLevels: Readonly<Record<string, AgentInteractionLevel>>;
  };
  readonly error?: { readonly kind: string; readonly message: string };
}

// ── Tool discovery ─────────────────────────────────────────────

export interface ToolDescriptor {
  readonly entity: string;
  readonly operation: string;
  readonly description?: string;
  readonly fields: readonly ToolFieldDescriptor[];
  readonly transitions?: readonly string[];
}

export interface ToolFieldDescriptor {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly interactionLevel: AgentInteractionLevel;
  readonly operators?: readonly string[];
}

// ── Agent session context ──────────────────────────────────────

export interface AgentSessionContext {
  readonly session: SessionRecord;
  readonly focusedEntity?: FocusedEntityContext;
  readonly activeBindings: readonly SessionBindingEntry[];
}

export interface SessionRecord {
  readonly id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly url?: string;
  readonly latest_binding_entity?: string;
  readonly latest_binding_view?: string;
  readonly active_bindings?: unknown;
  readonly last_activity: string;
}

export interface FocusedEntityContext {
  readonly entity: string;
  readonly view: string;
  readonly operations: readonly Operation[];
  readonly transitions: readonly string[];
  readonly fieldAccess: Readonly<Record<string, AgentInteractionLevel>>;
}

export interface SessionBindingEntry {
  readonly entity: string;
  readonly view: string;
  readonly fieldAccess: Readonly<Record<string, AgentInteractionLevel>>;
}

// ── Navigation tool discovery ─────────────────────────────────

export interface NavigationDescriptor {
  readonly entity: string;
  readonly view: string;
  readonly path: string;
  readonly label: string;
  readonly requiresId: boolean;
}
