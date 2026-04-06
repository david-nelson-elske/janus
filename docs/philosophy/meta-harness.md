# Meta-Harness Philosophy: Domain Over Orchestration

Janus is not an agent harness. It is a meta-harness.

An agent harness runs agents — it owns reasoning, tool orchestration, conversation management, and context windows. Claude Code is a harness. OpenClaw is a harness. Every generation of models produces better harnesses, and each generation subsumes capabilities that the previous generation had to build by hand.

A meta-harness does something different. It organizes a knowledge domain and makes it navigable by any harness. It doesn't care which agent is navigating. It cares that the domain is well-structured enough that any agent *can* navigate it effectively.

## The Bet

Agent harnesses face an existential question: how much of what they build today will be native to the next generation of models? Tool orchestration, context management, chain-of-thought scaffolding — these are all things that models are getting better at on their own. Building a harness means racing against model capabilities.

A meta-harness makes the opposite bet. It bets that:

1. **Models will always need domain knowledge.** No model comes out of the gate knowing your domain — your entities, relationships, permissions, lifecycles, and business rules. This knowledge has to be structured and provided.

2. **Models will always prefer structure.** Even as reasoning improves, agents will perform better against well-organized, queryable, self-describing systems than against unstructured blobs. A clean CLI, a typed schema, a discoverable operation set — these compound with model capability rather than competing with it.

3. **Permissions are permanent.** No matter how capable an agent becomes, it still needs to be constrained. Identity, ownership, access control — these are not scaffolding to be removed. They are load-bearing walls.

4. **Surfaces are projections, not features.** CLI, HTTP, MCP, SSE, voice — these are different lenses on the same entity graph. The domain doesn't change when the surface changes. Adding a new surface should be derivation, not construction.

The meta-harness maximizes the benefit of agent improvement. Every advance in model reasoning, tool calling, or context handling makes the domain *more* navigable, not obsolete. You're building the territory, not the map-reader.

## What This Means in Practice

### Janus provides:

- **The entity graph** — structured, queryable, FTS-indexed domain knowledge with typed fields, relations, and lifecycles
- **Operations and permissions** — CRUD + lifecycle transitions with identity, policy, and audit, enforced consistently across all surfaces
- **Self-description** — entity discovery, field introspection, operation enumeration, so any agent can learn the domain at runtime
- **Multiple surfaces** — CLI (for Claude Code), HTTP (for web/voice agents), MCP (for external agent integration), SSE (for real-time sync) — all derived from the same compiled registry
- **Persistence and coordination** — task tracking, session state, heartbeat conventions, so multiple agent sessions can work against the same domain without collision

### Janus does not provide:

- Agent reasoning loops
- Tool orchestration or chain-of-thought scaffolding
- Conversation management or context window optimization
- Model-specific API integration
- Prompt engineering infrastructure

These are the harness's job. Janus trusts that the harness — whether it's Claude Code today or whatever comes next — will handle reasoning. Janus handles knowledge.

## The PCA Example

Consider the Parkdale Community Association website. The goal is not to build an agent that knows about PCA. The goal is to make PCA's knowledge, services, and permissions so well-structured that *any* agent can navigate them:

- A resident using Claude Code locally could query community events, register for programs, or browse news — constrained by their identity and permissions
- A board member using a voice assistant could review reports and approve requests — same entity graph, different surface
- An MCP client could integrate PCA services into a broader personal agent — same operations, same permissions, new consumer
- A web browser with an embedded assistant could guide someone through pages — same knowledge, human-friendly projection

The domain is the constant. The agent is the variable.

## Harness vs. Meta-Harness

| Concern | Harness | Meta-Harness |
|---------|---------|--------------|
| Owns reasoning | Yes | No |
| Owns domain knowledge | No | Yes |
| Races against model improvements | Yes | No |
| Benefits from model improvements | Partially | Fully |
| Needs to be rebuilt per generation | Likely | No |
| Value increases with better agents | Diminishes | Compounds |

## Design Implications

1. **The CLI is a first-class surface**, not a debugging tool. It's how Claude Code (and future terminal-native agents) interact with the domain. Every operation available through HTTP should be available through the CLI.

2. **Self-description is infrastructure.** `janus entities`, `janus operations <entity>`, `janus fields <entity>` — these aren't convenience commands. They're how an agent learns the domain. The better the self-description, the less prompting any harness needs.

3. **MCP server derivation** follows the same pattern as HTTP route derivation. The compiled registry already knows every entity, operation, and field. Projecting that into MCP tool schemas is mechanical.

4. **Permissions don't soften for agents.** An agent calling `janus update task` goes through the same identity, policy, and audit pipeline as an HTTP request. The surface is different; the rules are identical.

5. **Task persistence is coordination.** The entity graph isn't just the application's data — it's the coordination layer for agents working on the application. Tasks, sessions, heartbeats, and claims are all entities, navigable by the same mechanisms.
