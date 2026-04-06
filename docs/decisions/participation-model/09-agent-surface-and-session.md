# 124-09: Agent Surface and Session

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md)–[08](08-http-surface-and-bootstrap.md), [10](10-presentation-and-binding.md) (binding records)

## Scope

This sub-ADR specifies:
- `agent-surface` as an initiator graph-node
- Agent transport execution adapters: agent-receive, agent-identity, agent-respond
- `session` entity (Volatile, per-user)
- Session updates on navigation/agent focus
- Agent interaction levels on bindings (read-write, read, aware)
- Default interaction level derivation from classified schema
- How the agent reads session + binding + graph-node to build context
- Voice output shaping via voice bindings
- Provider configuration (voice, VAD) on surface participation
- `agentSurface()` convenience constructor
- Tool discovery from the dispatch index

This sub-ADR does NOT cover:
- Collaborative editing protocol (CRDT/OT)
- Dynamic UI composition / slot model (deferred, see ADR-124 Decision 20)
- Actual AI model integration (API clients, prompt construction)
- Rendering adapter implementations ([10](10-presentation-and-binding.md))

## Agent surface

The `agent-surface` is how AI models consume the framework — discovering operations, calling tools, and receiving structured results. It follows the same initiator pattern as HTTP surfaces ([08](08-http-surface-and-bootstrap.md)).

```ts
function agentSurface(config?: Partial<AgentSurfaceConfig>): {
  definition: DefineResult;
  initiator: InitiatorConfig;
}

interface AgentSurfaceConfig {
  readonly name?: string;           // default: 'agent-surface'
}
```

### Agent transport executions

| Execution | order | transactional | Description |
|-----------|-------|---------------|-------------|
| `agent-receive` | 5 | false | Parse tool call input into dispatch context |
| `agent-identity` | 6 | false | Resolve agent identity (session-based or token-based) |
| `agent-respond` | 80 | false | Shape dispatch result into tool call response |

**agent-receive** extracts entity, operation, and input from the tool call format. The exact format depends on the AI model's tool calling contract.

**agent-identity** resolves the agent's identity. This may be a dedicated agent identity (with specific roles/scopes) or inherited from the user session the agent is acting within.

**agent-respond** shapes the dispatch result into a format suitable for the AI model — typically a structured JSON response that the model can interpret, with appropriate redaction based on agent interaction levels. When voice bindings exist for the target entity ([10](10-presentation-and-binding.md)), agent-respond uses them to shape the output — filtering to declared fields and applying labels — so the model produces better spoken summaries. This is unconditional: the agent surface always uses voice bindings when available, because concise, labeled data benefits both voice and text interactions.

```ts
const agentRespond: ExecutionHandler = async (ctx) => {
  const data = ctx.result?.data ?? ctx.result?.record ?? ctx.result?.page;

  if (ctx.error) {
    ctx.agentResponse = { ok: false, error: ctx.error };
    return;
  }

  // Use binding metadata to shape output for the agent
  const bindings = ctx.registry.bindings.byEntity(ctx.entity);
  if (bindings.length > 0) {
    // Shape response using field metadata and agent interaction levels from binding
    ctx.agentResponse = { ok: true, data: shapeByBinding(data, bindings[0]) };
  } else {
    ctx.agentResponse = { ok: true, data };
  }
};
```

### The surface IS the modality

There is no separate modality negotiation layer. Each surface's respond execution determines the output shape:

- **HTTP surfaces** return full structured JSON — the browser renders via visual bindings client-side.
- **Agent surface** returns voice-shaped JSON — the AI model handles text/speech multiplexing.
- **CLI surface** returns text-formatted output via text bindings.

Voice I/O is handled by the AI model's API (e.g., OpenAI Realtime API), not by the framework. The framework's role is to return well-shaped tool responses. The model decides whether to speak or type the answer based on its own session configuration.

The OpenAI Realtime API multiplexes across speech/text I/O combinations:

| Input | Output | Mode |
|-------|--------|------|
| Speech | Text | Transcription + tool response |
| Speech | Speech | Full voice pipeline |
| Text | Text | Standard tool calling |
| Text | Speech | TTS on tool response |

From the framework's perspective, all four modes are identical: a tool call arrives as JSON, the pipeline dispatches it, agent-respond returns shaped JSON. The audio layer is external to the framework.

Provider-specific configuration (voice choice, VAD thresholds, audio format) is external to the framework — it belongs to the AI model's API client, not to the entity graph.

## Session entity

The `session` entity is a Volatile per-user record that captures the user's current binding context:

```ts
const session = define('session', {
  schema: {
    userId: Str({ required: true }),
    url: Str(),
    latestBinding: Json(),
    activeBindings: Json(),
    lastActivity: DateTime({ required: true }),
    agentId: Str(),               // agent acting in this session
  },
  storage: Volatile(),
  description: 'Per-user session tracking binding context and agent focus',
});
```

### SessionRecord shape

```ts
interface SessionRecord {
  readonly id: string;            // = userId
  readonly userId: string;
  readonly url?: string;
  readonly latestBinding?: BindingContext;
  readonly activeBindings?: readonly BindingContext[];
  readonly lastActivity: string;  // ISO timestamp
  readonly agentId?: string;
}

interface BindingContext {
  readonly entity: string;
  readonly id?: string;
  readonly filter?: Record<string, unknown>;
  readonly view: string;
  readonly cursor?: CursorPosition;
}

interface CursorPosition {
  readonly field: string;
  readonly position: number;
  readonly selection?: [number, number];
}
```

### Session updates

The session is updated on navigation — one lightweight write per page change. The frontend router derives the active bindings from the URL + binding records ([10](10-presentation-and-binding.md)) and dispatches a session update through the normal pipeline:

```ts
// Frontend dispatches on navigation
dispatch('system', 'session', 'update', {
  id: userId,
  url: '/notes/123',
  latestBinding: { entity: 'note', id: '123', view: 'detail' },
  activeBindings: [
    { entity: 'note', id: '123', view: 'detail' },
    { entity: 'comment', filter: { noteId: '123' }, view: 'list' },
  ],
  lastActivity: new Date().toISOString(),
}, userIdentity);
```

## Agent interaction levels

Binding config ([10](10-presentation-and-binding.md)) carries per-field agent interaction levels that declare what the agent can see and do:

```ts
type AgentInteractionLevel = 'read-write' | 'read' | 'aware';
```

| Level | Agent can see value | Agent can modify | Use case |
|-------|-------------------|------------------|----------|
| `read-write` | Yes | Yes | Note title, document body, form fields |
| `read` | Yes | No | Status badges, computed fields, timestamps |
| `aware` | No (knows field name + type) | No | Credit card, SSN, passwords |

### Default derivation from classified schema

When no explicit interaction level is set in the binding config, defaults are derived from the field's classification:

| Classification | Default interaction level |
|---------------|-------------------------|
| `Public` | `read-write` |
| `Private` | `read` |
| `Sensitive` | `aware` |

The binding config overrides these defaults per-view:

```ts
bind('note', [
  { component: NoteDetail, view: 'detail', config: {
    fields: {
      title: { component: 'heading', agent: 'read-write' },
      body: { component: 'richtext', agent: 'read-write' },
      status: { component: 'badge', agent: 'read' },      // override: read-only even if Public
    },
  }},
]);
```

### Interaction level resolution

```ts
function deriveInteractionLevels(
  classifiedSchema: ClassifiedSchema,
  bindingConfig?: Record<string, FieldBindingConfig>,
): Record<string, AgentInteractionLevel>
```

For each field: use the binding config's explicit `agent` level if present, otherwise derive from the field's classification.

## Agent context building

The agent reads multiple entities to understand what the user is doing:

```ts
function buildAgentContext(config: {
  session: SessionRecord;
  bindings: readonly BindingRecord[];
  graphNodes: ReadonlyMap<string, GraphNodeRecord>;
  store: EntityStore;
}): Promise<AgentSessionContext>

interface AgentSessionContext {
  readonly session: SessionRecord;
  readonly focusedEntity?: {
    readonly graphNode: GraphNodeRecord;
    readonly record?: EntityRecord;       // the actual entity data
    readonly operations: readonly Operation[];
    readonly actions: readonly string[];   // custom action names
    readonly fieldAccess: Record<string, AgentInteractionLevel>;
  };
  readonly activeBindings: readonly {
    readonly entity: string;
    readonly view: string;
    readonly fieldAccess: Record<string, AgentInteractionLevel>;
  }[];
}
```

**Resolution:**
1. Read session record for the user.
2. From `session.latestBinding`, resolve the entity's graph-node.
3. Derive interaction levels from classified schema + binding config.
4. If binding has an id, read the actual entity record (filtering out `aware` fields).
5. Collect available operations and actions from the dispatch index.
6. Repeat for `activeBindings` (the other things on screen).

The agent can then reason: "Alice is viewing note 123 in detail view. Title and body are editable. Status is read-only. She can update, delete, publish, archive, or pin."

## Tool discovery

The agent discovers available tools by querying the dispatch index and graph-node table:

```ts
function discoverTools(config: {
  registry: CompileResult;
  initiator: string;
  identity: Identity;
}): readonly ToolDescriptor[]

interface ToolDescriptor {
  readonly entity: string;
  readonly operation: Operation | string; // string for actions
  readonly description: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly scoped: boolean;              // requires entityId?
}
```

The tool set is filtered by what's available in the dispatch index for the given initiator, and by what the identity's policy rules permit.

## Testing gate

When 124-09 is implemented, the following should be testable:

- `agentSurface()` produces correct definition + initiator config
- Agent surface initiator produces correct pipeline join (agent-receive + entity concerns + agent-respond)
- Session entity is Volatile, operations: ['read', 'update'] (effectively Singleton per-user)
- Session update writes correct binding context
- Interaction level derivation: Public → read-write, Private → read, Sensitive → aware
- Binding-level overrides applied correctly
- `buildAgentContext()` reads session, resolves bindings, derives field access
- Agent context correctly filters `aware` fields (field name + type visible, value hidden)
- Tool discovery returns operations available to the identity
- Tool discovery filters by policy rules
- `agent-respond` uses voice bindings (when available) to shape tool output
- `agent-respond` returns full data when no voice binding exists
