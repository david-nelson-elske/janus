# Janus Dev App

Development tracker for the Janus framework itself. Tracks ADRs, implementation tasks, design questions, and test runs in a SQLite database (`janus.db`).

## CLI

```bash
bun run janus <command>
```

## Working with the Domain

This project tracks its state in a Janus entity graph persisted to SQLite. Use the CLI to read and update domain state as you work -- the database is the source of truth for project state, not conversation memory.

### Orient yourself

Before starting work in an unfamiliar area, discover what's available:

```bash
bun run janus entities                          # What entities exist
bun run janus operations <entity>               # CRUD ops + lifecycle transitions
bun run janus fields <entity>                   # Field names, types, query operators
```

### Workflow

1. **Start of session** -- check what's open before deciding what to do:
   ```bash
   bun run janus read task --where status=pending
   bun run janus read task --where status=in_progress
   bun run janus read question --where status=open
   ```

2. **When you start a task** -- update its status:
   ```bash
   bun run janus update task --id <id> --status in_progress
   ```

3. **When you identify new work** -- create a task for it:
   ```bash
   bun run janus create task --title "Implement X" --priority high --adr <adr-id>
   ```

4. **When you finish** -- mark it done and note follow-ups:
   ```bash
   bun run janus dispatch task:completed --id <id>
   ```

5. **When a design question comes up** -- record it:
   ```bash
   bun run janus create question --title "Should X do Y?" --adr <adr-id>
   ```

6. **After running tests** -- record the result:
   ```bash
   bun run janus create test_run --suite "packages/" --passed 1154 --failed 0 --skipped 0 --duration 3200 --commit $(git rev-parse --short HEAD) --timestamp $(date -u +%Y-%m-%dT%H:%M:%SZ)
   ```

Use `--json` when you need structured output for decision-making. Use `--search "term"` for full-text search across records.

## Entities

| Entity | What to track | Lifecycle |
|--------|--------------|-----------|
| `task` | Implementation work items | pending -> in_progress -> blocked -> completed |
| `adr` | Architecture decision records | draft -> accepted -> implemented -> superseded |
| `question` | Open design questions | open -> resolved -> deferred |
| `test_run` | Test suite execution snapshots | (no lifecycle) |
| `task_summary` | Live computed totals (read-only) | (derived) |

## Seed

```bash
bun run janus:seed    # Re-seed from ADR docs (destructive)
```
