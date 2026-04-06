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
): Promise<string> {
  const res = await runtime.dispatch(initiator, entity, operation, input);
  if (!res.ok) return json ? formatJson(res) : `Error: ${res.error?.message}`;
  return json ? formatJson(res.data) : formatOk(res.data);
}

// ── Command execution ───────────────────────────────────────────

export async function executeCommand(
  parsed: ParsedArgs,
  runtime?: DispatchRuntime,
  registry?: CompileResult,
): Promise<string> {
  switch (parsed.command) {
    case 'entities':
      return cmdEntities(registry!, parsed.json);
    case 'operations':
      return cmdOperations(parsed.entity, registry!, parsed.json);
    case 'fields':
      return cmdFields(parsed.entity, registry!, parsed.json);
    case 'read':
      return cmdRead(parsed, runtime!, parsed.json);
    case 'create':
      return cmdCreate(parsed, runtime!, parsed.json);
    case 'update':
      return cmdUpdate(parsed, runtime!, parsed.json);
    case 'delete':
      return cmdDelete(parsed, runtime!, parsed.json);
    case 'dispatch':
      return cmdDispatch(parsed, runtime!, parsed.json);
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

async function cmdRead(parsed: ParsedArgs, runtime: DispatchRuntime, json: boolean): Promise<string> {
  if (!parsed.entity) return 'Usage: janus read <entity> [--id <id>] [--where key=val] [--search term]';

  const input: Record<string, unknown> = {};
  if (parsed.flags.id) input.id = parsed.flags.id;
  if (parsed.flags.where) input.where = parseWhere(parsed.flags.where);
  if (parsed.flags.search) input.search = parsed.flags.search;

  return dispatchAndFormat(runtime, 'system', parsed.entity, 'read', input, json, (data) => {
    const record = data as Record<string, unknown>;
    if (record && 'records' in record) {
      const page = record as { records: Record<string, unknown>[]; total?: number };
      const suffix = page.total !== undefined ? `\n\n${page.records.length} of ${page.total} records` : '';
      return formatTable(page.records) + suffix;
    }
    return formatRecord(record);
  });
}

async function cmdCreate(parsed: ParsedArgs, runtime: DispatchRuntime, json: boolean): Promise<string> {
  if (!parsed.entity) return 'Usage: janus create <entity> --field value ...';

  return dispatchAndFormat(
    runtime, 'system', parsed.entity, 'create', flagsToInput(parsed.flags), json,
    (data) => `Created:\n${formatRecord(data as Record<string, unknown>)}`,
  );
}

async function cmdUpdate(parsed: ParsedArgs, runtime: DispatchRuntime, json: boolean): Promise<string> {
  if (!parsed.entity) return 'Usage: janus update <entity> --id <id> --field value ...';
  if (!parsed.flags.id) return 'Error: --id is required for update';

  return dispatchAndFormat(
    runtime, 'system', parsed.entity, 'update', flagsToInput(parsed.flags), json,
    (data) => `Updated:\n${formatRecord(data as Record<string, unknown>)}`,
  );
}

async function cmdDelete(parsed: ParsedArgs, runtime: DispatchRuntime, json: boolean): Promise<string> {
  if (!parsed.entity) return 'Usage: janus delete <entity> --id <id>';
  if (!parsed.flags.id) return 'Error: --id is required for delete';

  return dispatchAndFormat(
    runtime, 'system', parsed.entity, 'delete', { id: parsed.flags.id }, json,
    () => `Deleted ${parsed.entity} ${parsed.flags.id}`,
  );
}

async function cmdDispatch(parsed: ParsedArgs, runtime: DispatchRuntime, json: boolean): Promise<string> {
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

  return dispatchAndFormat(runtime, 'system', parsed.entity, operation, input, json, (data) => {
    if (data && typeof data === 'object') {
      if ('records' in data) {
        return formatTable((data as { records: Record<string, unknown>[] }).records);
      }
      return formatRecord(data as Record<string, unknown>);
    }
    return 'OK';
  });
}

function cmdHelp(): string {
  return `janus — Janus development tracker CLI

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
  --where key=val                         Filter (for read)`;
}
