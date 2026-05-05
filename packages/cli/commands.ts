/**
 * CLI command routing and execution.
 *
 * Maps CLI commands to dispatch calls against the demo app.
 */

import type { CompileResult } from '@janus/core';
import type { DispatchRuntime } from '@janus/pipeline';
import {
  formatJson,
  formatTable,
  formatRecord,
  formatOperations,
  formatFields,
  formatEntities,
} from './format';

// ── Argument parsing ────────────────────────────────────────────

export interface ParsedArgs {
  command: string;
  entity?: string;
  operation?: string;
  flags: Record<string, string>;
  json: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip bun and script path
  const flags: Record<string, string> = {};
  let json = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--') && i + 1 < args.length) {
      const key = arg.slice(2);
      flags[key] = args[++i];
    } else {
      positional.push(arg);
    }
  }

  const command = positional[0] ?? 'help';
  let entity: string | undefined;
  let operation: string | undefined;

  if (positional.length > 1) {
    const second = positional[1];
    // Handle entity:operation syntax (e.g., "task:in_progress")
    if (second.includes(':')) {
      const [e, op] = second.split(':', 2);
      entity = e;
      operation = op;
    } else {
      entity = second;
    }
  }

  return { command, entity, operation, flags, json };
}

// ── Where clause parsing ────────────────────────────────────────

function parseWhere(raw: string): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  // Support: key=value, key!=value, key>value, key<value
  for (const part of raw.split(/\s+AND\s+/i)) {
    const match = part.match(/^(\w+)(!=|>=|<=|>|<|=)(.+)$/);
    if (match) {
      const [, field, op, value] = match;
      const parsed = parseValue(value);
      switch (op) {
        case '=':
          where[field] = parsed;
          break;
        case '!=':
          where[field] = { $ne: parsed };
          break;
        case '>':
          where[field] = { $gt: parsed };
          break;
        case '<':
          where[field] = { $lt: parsed };
          break;
        case '>=':
          where[field] = { $gte: parsed };
          break;
        case '<=':
          where[field] = { $lte: parsed };
          break;
      }
    }
  }
  return where;
}

function parseValue(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  if (!Number.isNaN(num) && raw.trim() !== '') return num;
  return raw;
}

// ── Shared helpers ─────────────────────────────────────────────

function flagsToInput(flags: Record<string, string>, exclude?: Set<string>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (!exclude || !exclude.has(key)) input[key] = parseValue(value);
  }
  return input;
}

async function dispatchAndFormat(
  runtime: DispatchRuntime,
  initiator: string,
  entity: string,
  operation: string,
  input: Record<string, unknown>,
  json: boolean,
  formatOk: (data: unknown) => string,
  identity?: CLIIdentity,
): Promise<string> {
  const res = await runtime.dispatch(initiator, entity, operation, input, identity as any);
  if (!res.ok) return json ? formatJson(res) : `Error: ${res.error?.message}`;
  return json ? formatJson(res.data) : formatOk(res.data);
}

// ── Command execution ───────────────────────────────────────────

export async function executeCommand(
  parsed: ParsedArgs,
  runtime?: DispatchRuntime,
  registry?: CompileResult,
  initiator = 'system',
  identity?: CLIIdentity,
): Promise<string> {
  switch (parsed.command) {
    case 'entities':
      return cmdEntities(registry!, parsed.json);
    case 'operations':
      return cmdOperations(parsed.entity, registry!, parsed.json);
    case 'fields':
      return cmdFields(parsed.entity, registry!, parsed.json);
    case 'read':
      return cmdRead(parsed, runtime!, parsed.json, initiator, identity);
    case 'create':
      return cmdCreate(parsed, runtime!, parsed.json, initiator, identity);
    case 'update':
      return cmdUpdate(parsed, runtime!, parsed.json, initiator, identity);
    case 'delete':
      return cmdDelete(parsed, runtime!, parsed.json, initiator, identity);
    case 'dispatch':
      return cmdDispatch(parsed, runtime!, parsed.json, initiator, identity);
    case 'help':
    default:
      return cmdHelp();
  }
}

// ── Commands ────────────────────────────────────────────────────

function cmdEntities(registry: CompileResult, json: boolean): string {
  const names = [...registry.graphNodes.keys()].sort();
  if (json) return formatJson(names);
  return formatEntities(names);
}

function cmdOperations(entity: string | undefined, registry: CompileResult, json: boolean): string {
  if (!entity) return 'Usage: janus operations <entity>';
  const node = registry.entity(entity);
  if (!node) return `Unknown entity: '${entity}'`;

  const ops = [...node.operations];
  const transitions = node.transitionTargets.map((t) => t.name);
  if (json) return formatJson({ operations: ops, transitions });
  return formatOperations(ops, transitions, entity);
}

function cmdFields(entity: string | undefined, registry: CompileResult, json: boolean): string {
  if (!entity) return 'Usage: janus fields <entity>';
  const node = registry.entity(entity);
  if (!node) return `Unknown entity: '${entity}'`;

  const queryFields = registry.queryFields(entity);

  if (json) return formatJson(queryFields);

  // Human-readable table with operators
  const lines = [`Fields for ${entity}:`, ''];
  for (const qf of queryFields) {
    const req = qf.required ? ' (required)' : '';
    const ops = qf.operators.join(', ');
    lines.push(`  ${qf.field.padEnd(20)} ${qf.type.padEnd(12)} [${ops}]${req}`);
  }
  return lines.join('\n');
}

async function cmdRead(parsed: ParsedArgs, runtime: DispatchRuntime, json: boolean, initiator = 'system', identity?: CLIIdentity): Promise<string> {
  if (!parsed.entity) return 'Usage: janus read <entity> [--id <id>] [--where key=val] [--search term]';

  const input: Record<string, unknown> = {};
  if (parsed.flags.id) input.id = parsed.flags.id;
  if (parsed.flags.where) input.where = parseWhere(parsed.flags.where);
  if (parsed.flags.search) input.search = parsed.flags.search;
  if (parsed.flags.lang) input.lang = parsed.flags.lang;

  return dispatchAndFormat(runtime, initiator, parsed.entity, 'read', input, json, (data) => {
    const record = data as Record<string, unknown>;
    if (record && 'records' in record) {
      const page = record as { records: Record<string, unknown>[]; total?: number };
      const suffix = page.total !== undefined ? `\n\n${page.records.length} of ${page.total} records` : '';
      return formatTable(page.records) + suffix;
    }
    return formatRecord(record);
  }, identity);
}

async function cmdCreate(parsed: ParsedArgs, runtime: DispatchRuntime, json: boolean, initiator = 'system', identity?: CLIIdentity): Promise<string> {
  if (!parsed.entity) return 'Usage: janus create <entity> --field value ...';

  return dispatchAndFormat(
    runtime, initiator, parsed.entity, 'create', flagsToInput(parsed.flags), json,
    (data) => `Created:\n${formatRecord(data as Record<string, unknown>)}`,
    identity,
  );
}

async function cmdUpdate(parsed: ParsedArgs, runtime: DispatchRuntime, json: boolean, initiator = 'system', identity?: CLIIdentity): Promise<string> {
  if (!parsed.entity) return 'Usage: janus update <entity> --id <id> --field value ...';
  if (!parsed.flags.id) return 'Error: --id is required for update';

  return dispatchAndFormat(
    runtime, initiator, parsed.entity, 'update', flagsToInput(parsed.flags), json,
    (data) => `Updated:\n${formatRecord(data as Record<string, unknown>)}`,
    identity,
  );
}

async function cmdDelete(parsed: ParsedArgs, runtime: DispatchRuntime, json: boolean, initiator = 'system', identity?: CLIIdentity): Promise<string> {
  if (!parsed.entity) return 'Usage: janus delete <entity> --id <id>';
  if (!parsed.flags.id) return 'Error: --id is required for delete';

  return dispatchAndFormat(
    runtime, initiator, parsed.entity, 'delete', { id: parsed.flags.id }, json,
    () => `Deleted ${parsed.entity} ${parsed.flags.id}`,
    identity,
  );
}

async function cmdDispatch(parsed: ParsedArgs, runtime: DispatchRuntime, json: boolean, initiator = 'system', identity?: CLIIdentity): Promise<string> {
  if (!parsed.entity) return 'Usage: janus dispatch <entity>:<operation> [--id <id>] [--input \'{}\']]';

  const operation = parsed.operation;
  if (!operation) return 'Usage: janus dispatch <entity>:<operation>';

  const input: Record<string, unknown> = {};
  if (parsed.flags.input) {
    try {
      Object.assign(input, JSON.parse(parsed.flags.input));
    } catch {
      return 'Error: --input must be valid JSON';
    }
  }
  Object.assign(input, flagsToInput(parsed.flags, new Set(['input'])));

  return dispatchAndFormat(runtime, initiator, parsed.entity, operation, input, json, (data) => {
    if (data && typeof data === 'object') {
      if ('records' in data) {
        return formatTable((data as { records: Record<string, unknown>[] }).records);
      }
      return formatRecord(data as Record<string, unknown>);
    }
    return 'OK';
  }, identity);
}

function cmdHelp(appName = 'janus', extraHelp = ''): string {
  return `${appName} — entity CLI

Commands:
  entities                                List all entities
  operations <entity>                     List operations for an entity
  fields <entity>                         List fields for an entity
  read <entity> [--id <id>]               Read records
  create <entity> --field value ...       Create a record
  update <entity> --id <id> --field val   Update a record
  delete <entity> --id <id>               Delete a record
  dispatch <entity>:<op> [--id <id>]      Dispatch a named operation

Flags:
  --json                                  Output as JSON (for agents)
  --where key=val                         Filter (for read)${extraHelp}`;
}

// ── Reusable CLI runner ─────────────────────────────────────────

export interface CLIIdentity {
  readonly id: string;
  readonly roles: readonly string[];
}

export interface CLIConfig {
  /** Factory that boots the app. Called for all commands except help. */
  boot: () => Promise<{ runtime: DispatchRuntime; registry: CompileResult; shutdown?: () => Promise<void> }>;
  /** App name shown in help text. */
  name?: string;
  /** Initiator name for dispatch calls. Default: 'system'. */
  initiator?: string;
  /** Identity passed to dispatch for policy evaluation. Default: { id: 'system', roles: ['system'] }. */
  identity?: CLIIdentity;
  /** Extra commands beyond the built-in CRUD set. */
  extraCommands?: Record<string, (parsed: ParsedArgs, runtime: DispatchRuntime, registry: CompileResult) => Promise<string>>;
  /** Extra help text appended to the built-in help. */
  extraHelp?: string;
}

/**
 * Run the CLI with the given configuration. Call from your entry point:
 *
 *   runCLI({ boot: () => createApp({ declarations, store }), name: 'myapp' });
 */
export async function runCLI(config: CLIConfig): Promise<void> {
  const parsed = parseArgs(process.argv);

  try {
    // Check extra commands first
    if (config.extraCommands?.[parsed.command]) {
      const app = await config.boot();
      const output = await config.extraCommands[parsed.command](parsed, app.runtime, app.registry);
      console.log(output);
      await app.shutdown?.();
      process.exit(0);
    }

    if (parsed.command === 'help') {
      console.log(cmdHelp(config.name, config.extraHelp));
      process.exit(0);
    }

    const app = await config.boot();
    const output = await executeCommand(parsed, app.runtime, app.registry, config.initiator, config.identity);
    console.log(output);
    await app.shutdown?.();
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
