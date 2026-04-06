# 124-13: External Agent Harness Integration

**Status:** Draft
**Date:** 2026-04-03
**Depends on:** [08](08-http-surface-and-bootstrap.md) (HTTP Surface), [09](09-agent-surface-and-session.md) (Agent Surface)

## Scope

This sub-ADR specifies:
- How Janus relates to external agent harnesses (Claude Code, Hermes, OpenClaw, etc.)
- The integration boundary: what external agents access via Janus's API vs what they access directly
- CLI as the development-time bridge between external harnesses and the running application
- How the dispatch interface maps to external tool-calling protocols
- The dogfooding pattern: Janus tracking its own development

This sub-ADR does NOT cover:
- Internal agent surface ([09](09-agent-surface-and-session.md) — agent living inside Janus)
- MCP server implementation details (future work)
- Specific external harness adapters

## Context

### Two kinds of agents

Janus has an agent surface ([09](09-agent-surface-and-session.md)) for agents that live *inside* the framework — they discover tools from the dispatch index, interact with binding contexts, and participate in sessions. This is the internal agent model.

But in practice, the most powerful agents today live *outside* the application:
- **Claude Code** operates on the codebase, runs tests, navigates files, and builds the framework itself
- **Hermes / OpenClaw** manage long-running tasks with persistent state across sessions
- **Custom orchestrators** chain LLM calls with tool use

These external agents don't run inside Janus's process. They need to access Janus as a tool — querying entities, creating records, reading execution logs — through an external interface. The agent surface as specified in 09 assumes co-location. This sub-ADR specifies the external integration path.

### The complementary relationship

External agent harnesses and Janus serve different roles:

| Concern | External harness (Claude Code) | Janus |
|---------|-------------------------------|-------|
| **What it does** | Navigates codebase, writes code, runs tests, reasons about architecture | Manages structured data, dispatches operations, tracks state, serves UI |
| **Where state lives** | Files on disk, git history, conversation context | Database tables, entity records, execution logs |
| **What it's good at** | Open-ended reasoning, code generation, exploration | Structured CRUD, audit trails, search, subscriptions, persistence |
| **Runtime** | Development-time (build, test, deploy) | Application-time (serve, dispatch, sync) |

They are complementary layers, not competitors. Claude Code builds the app; Janus is what gets built. But there's an overlap zone: **persistent structured state that agents need across sessions** — task tracking, decision logs, shared memory, project status. This is where Janus becomes a tool that external agents use.

## Decision

### 1. Three integration surfaces

External agents access Janus through three surfaces, each suited to different contexts:

#### HTTP API (primary)

The `api_surface` already exposes every entity's CRUD operations as REST endpoints. An external agent that can make HTTP calls has full access:

```
# External agent reads all notes
GET /api/note

# External agent creates a task
POST /api/task { "title": "Implement compile()", "status": "pending" }

# External agent queries execution log
GET /api/execution_log?handler=audit-relational&source=note

# External agent reads dispatch index (tool discovery)
GET /api/dispatch_index?initiator=api_surface&entity=note
```

No special adapter needed — the existing HTTP surface serves external agents identically to any other HTTP client. Authentication uses the same identity mechanisms (JWT, API key).

#### CLI (development-time bridge)

A thin CLI that wraps HTTP calls to the running Janus instance:

```bash
# Query entities
janus read note --where status=published
janus read execution_log --where "handler=audit-relational" --limit 10

# Create records
janus create task --title "Implement compile()" --status pending

# Dispatch operations
janus dispatch note:create --input '{"title": "New note"}'

# Discovery
janus operations note          # list available operations
janus fields note              # list fields with types and operators
janus pipeline api_surface note create  # show assembled pipeline
```

The CLI is the natural bridge for Claude Code: instead of importing Janus libraries or parsing database files, Claude Code runs CLI commands to interact with the running application. This keeps the boundary clean — Claude Code reads code for structure, uses the CLI for runtime state.

#### MCP server (future)

The dispatch interface maps naturally to MCP's tool-calling protocol:

```json
{
  "tools": [
    {
      "name": "janus_read",
      "description": "Read entity records",
      "parameters": { "entity": "string", "where": "object", "limit": "number" }
    },
    {
      "name": "janus_create",
      "description": "Create an entity record",
      "parameters": { "entity": "string", "input": "object" }
    },
    {
      "name": "janus_dispatch",
      "description": "Dispatch an operation",
      "parameters": { "entity": "string", "operation": "string", "input": "object" }
    }
  ]
}
```

Because Janus operations are uniform (four CRUD operations + custom actions, same interface for every entity), the MCP tool surface is small and fixed — three to five tools that work across all entities. The `query_field` entity provides parameter discovery, so the agent can learn what filters are available for any entity without hardcoded documentation.

### 2. The integration boundary

When should an external agent use Janus vs access the codebase directly?

| Need | Access via | Why |
|------|-----------|-----|
| **What entities exist, what fields they have** | Read code (`define()` calls) | Structure is in the source |
| **What operations are available** | CLI / API (`dispatch_index`) | Computed at compile time |
| **What's in the database right now** | CLI / API (`read`) | Runtime state |
| **Create/update/delete records** | CLI / API (`create`, `update`, `delete`) | Goes through full pipeline (policy, validate, audit) |
| **What happened (audit, execution history)** | CLI / API (`execution_log`) | Runtime state |
| **What the pipeline does for a specific operation** | CLI / API (`dispatch_index`) | Compiled pipeline shape |
| **How the code works, architecture decisions** | Read code / ADRs | Source of truth is files |
| **Run tests, check types** | Shell commands (`bun test`, `bun run typecheck`) | Development tooling |

The rule: **structure and logic live in code; runtime state lives in the database.** External agents read code to understand the framework. They use the API/CLI to interact with the running application.

### 3. External agent as initiator

When an external agent calls the HTTP API, it arrives through `api_surface` (or `admin_surface`) like any other HTTP client. The identity is resolved from the auth token. The pipeline runs normally.

If external agents need distinct pipeline behavior (different rate limits, elevated permissions, separate audit trail), a dedicated surface can be created:

```ts
const externalAgentSurface = apiSurface({
  name: 'external_agent_surface',
  identity: { method: 'apikey', header: 'X-Agent-Key' },
});

// Participate with agent-specific config
participate(externalAgentSurface, {
  rateLimit: { max: 1000, window: 60000 },  // higher limits for agents
});
```

This gives external agents their own entry in the dispatch index, their own audit trail (filterable by `initiator='external_agent_surface'`), and their own pipeline configuration — all through existing mechanisms.

### 4. Dogfooding: Janus tracking its own development

The strongest proof of the framework is using it to build itself. A Janus application running during development, backed by SQLite, tracking:

- **ADR decisions** — entity with lifecycle (draft → accepted → implemented → superseded)
- **Implementation tasks** — entity with lifecycle (pending → in_progress → completed)
- **Test results** — entity recording test suite runs, pass/fail counts, duration
- **Design questions** — entity for open questions, resolution status, linked ADRs

Claude Code interacts with this application via CLI during development sessions. The agent creates tasks, updates status, queries what's blocked, reviews execution history. The same data is visible through a web UI for human review.

This is not a toy example — it exercises:
- Entity definition and CRUD operations
- Lifecycle transitions (task states, ADR states)
- Ownership (tasks assigned to specific agents or humans)
- Search and filtering (find all in-progress tasks, find all ADRs in draft)
- Execution logging (audit trail of who changed what)
- Subscriptions (notify on ADR status change)
- The CLI integration surface

The demo application becomes the project's persistent memory — surviving across Claude Code sessions, queryable by any agent, visible to any team member.

### 5. What this does NOT replace

Janus does not replace the external agent harness. Claude Code still:
- Reads and writes source files
- Runs tests and type checks
- Reasons about architecture
- Manages git operations
- Has its own conversation context and memory

Janus provides the **structured, persistent, shared state layer** that external agents lack. Claude Code's `.claude/` memory is per-project, per-user, file-based, and not queryable. Janus entities are shared, queryable, permissioned, and audited.

The integration is additive: the external harness gains a persistent backend without losing any of its existing capabilities.

## Open questions

### MCP vs HTTP for Claude Code

Claude Code currently supports MCP servers for tool integration. Should the primary integration be MCP (native tool calling) or CLI (shell commands)? MCP is cleaner for structured tool use but requires running a server. CLI is simpler — Claude Code already runs shell commands — but loses structured input/output. Both can coexist; the question is which to prioritize.

### Agent identity across harnesses

When Claude Code creates a record via the CLI, what identity does it use? Options:
- A shared API key per project (simple, but no per-agent attribution)
- Per-agent API keys (Claude Code session gets its own key, tracks who did what)
- Map external harness identity to Janus user (Claude Code → `agent-claude-code` user)

This affects audit trails and ownership scoping.

### Session continuity

The internal agent surface tracks session state (what the agent is looking at, what it's working on). Should external agents have session entities too? This would let Janus track "Claude Code is currently working on the compile module" — useful for multi-agent coordination, but adds complexity.

## Testing gate

When 124-13 is implemented:

- CLI can `read`, `create`, `update`, `delete` against a running Janus instance
- CLI `dispatch` invokes the full pipeline (policy, validate, persist, audit, emit)
- CLI `operations` lists available operations for an entity
- CLI `fields` lists fields with semantic types and query operators
- CLI `pipeline` shows the assembled pipeline for a (surface, entity, operation) triple
- HTTP API serves the same operations (CLI wraps HTTP)
- External agent API key authenticates through existing identity mechanisms
- Dispatch index query returns discoverable operations for external agents
- `query_field` query returns field metadata for parameter discovery
