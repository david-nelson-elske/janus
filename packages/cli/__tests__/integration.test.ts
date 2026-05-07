/**
 * CLI integration tests — boot the demo app with an in-memory SQLite
 * and verify full command roundtrips.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearRegistry } from '@janus/core';
import type { CompileResult } from '@janus/core';
import type { DispatchRuntime } from '@janus/pipeline';
import { boot } from '../../../examples/dev-app/app';
import { parseArgs, executeCommand } from '../commands';

let runtime: DispatchRuntime;
let registry: CompileResult;

beforeEach(async () => {
  clearRegistry();
  const app = await boot(':memory:');
  runtime = app.runtime;
  registry = app.registry;
});

afterEach(() => {
  clearRegistry();
});

async function run(args: string): Promise<string> {
  // Split respecting quoted strings
  const parts = args.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  // Strip quotes from values
  const cleaned = parts.map((p) => p.replace(/^"|"$/g, ''));
  const parsed = parseArgs(['bun', 'janus', ...cleaned]);
  return executeCommand(parsed, runtime, registry);
}

// ── Entity discovery ────────────────────────────────────────────

describe('entities command', () => {
  test('lists all four demo entities', async () => {
    const output = await run('entities');
    expect(output).toContain('adr');
    expect(output).toContain('task');
    expect(output).toContain('test_run');
    expect(output).toContain('question');
  });

  test('JSON output returns array', async () => {
    const output = await run('entities --json');
    const data = JSON.parse(output);
    expect(Array.isArray(data)).toBe(true);
    expect(data).toContain('task');
  });
});

describe('operations command', () => {
  test('task has CRUD + lifecycle transitions', async () => {
    const output = await run('operations task');
    expect(output).toContain('read');
    expect(output).toContain('create');
    expect(output).toContain('update');
    expect(output).toContain('delete');
    expect(output).toContain('in_progress');
    expect(output).toContain('completed');
    expect(output).toContain('blocked');
  });
});

describe('fields command', () => {
  test('task shows fields with types', async () => {
    const output = await run('fields task');
    expect(output).toContain('title');
    expect(output).toContain('str');
    expect(output).toContain('priority');
    expect(output).toContain('enum');
    expect(output).toContain('status');
    expect(output).toContain('lifecycle');
  });
});

// ── CRUD roundtrip ──────────────────────────────────────────────

describe('CRUD commands', () => {
  test('create → read roundtrip', async () => {
    const createOutput = await run('create task --title "First task" --priority high');
    expect(createOutput).toContain('First task');
    expect(createOutput).toContain('pending'); // lifecycle initial

    const readOutput = await run('read task');
    expect(readOutput).toContain('First task');
  });

  test('create → read by id', async () => {
    const createOutput = await run('create task --title "Test" --json');
    const record = JSON.parse(createOutput);
    const id = record.id;

    const readOutput = await run(`read task --id ${id}`);
    expect(readOutput).toContain('Test');
    expect(readOutput).toContain(id);
  });

  test('create → update → read shows updated value', async () => {
    const createOutput = await run('create task --title "Original" --json');
    const id = JSON.parse(createOutput).id;

    const updateOutput = await run(`update task --id ${id} --title "Modified"`);
    expect(updateOutput).toContain('Modified');

    const readOutput = await run(`read task --id ${id}`);
    expect(readOutput).toContain('Modified');
  });

  test('create → delete → read returns error', async () => {
    const createOutput = await run('create task --title "ToDelete" --json');
    const id = JSON.parse(createOutput).id;

    const deleteOutput = await run(`delete task --id ${id}`);
    expect(deleteOutput).toContain('Deleted');

    const readOutput = await run(`read task --id ${id}`);
    expect(readOutput).toContain('Error');
  });
});

// ── Lifecycle transitions ───────────────────────────────────────

describe('lifecycle transitions', () => {
  test('dispatch task:in_progress transitions status', async () => {
    const createOutput = await run('create task --title "My task" --json');
    const id = JSON.parse(createOutput).id;

    const dispatchOutput = await run(`dispatch task:in_progress --id ${id} --json`);
    const updated = JSON.parse(dispatchOutput);
    expect(updated.status).toBe('in_progress');
  });

  test('dispatch task:completed after in_progress works', async () => {
    const createOutput = await run('create task --title "My task" --json');
    const id = JSON.parse(createOutput).id;

    await run(`dispatch task:in_progress --id ${id}`);
    const output = await run(`dispatch task:completed --id ${id} --json`);
    const record = JSON.parse(output);
    expect(record.status).toBe('completed');
  });

  test('invalid transition returns error', async () => {
    const createOutput = await run('create task --title "My task" --json');
    const id = JSON.parse(createOutput).id;

    // pending → completed is not valid (must go through in_progress)
    const output = await run(`dispatch task:completed --id ${id}`);
    expect(output).toContain('Error');
  });
});

// ── Multiple entities ───────────────────────────────────────────

describe('multiple entities', () => {
  test('different entities are independent', async () => {
    await run('create task --title "A task"');
    await run('create adr --title "An ADR" --number 1');

    const tasks = await run('read task --json');
    const adrs = await run('read adr --json');

    expect(JSON.parse(tasks).records).toHaveLength(1);
    expect(JSON.parse(adrs).records).toHaveLength(1);
  });
});

// ── Parse arguments ─────────────────────────────────────────────

describe('parseArgs', () => {
  test('parses command and entity', () => {
    const parsed = parseArgs(['bun', 'janus', 'read', 'task']);
    expect(parsed.command).toBe('read');
    expect(parsed.entity).toBe('task');
  });

  test('parses entity:operation', () => {
    const parsed = parseArgs(['bun', 'janus', 'dispatch', 'task:in_progress']);
    expect(parsed.command).toBe('dispatch');
    expect(parsed.entity).toBe('task');
    expect(parsed.operation).toBe('in_progress');
  });

  test('parses --json flag', () => {
    const parsed = parseArgs(['bun', 'janus', 'read', 'task', '--json']);
    expect(parsed.json).toBe(true);
  });

  test('parses --key value flags', () => {
    const parsed = parseArgs(['bun', 'janus', 'create', 'task', '--title', 'Test', '--priority', 'high']);
    expect(parsed.flags.title).toBe('Test');
    expect(parsed.flags.priority).toBe('high');
  });

  test('defaults to help', () => {
    const parsed = parseArgs(['bun', 'janus']);
    expect(parsed.command).toBe('help');
  });
});

// ── Capability commands ────────────────────────────────────────

describe('capabilities command', () => {
  test('lists all dev-app capabilities', async () => {
    const output = await run('capabilities');
    expect(output).toContain('Capabilities:');
    expect(output).toContain('system__time');
    expect(output).toContain('web__fetch');
    expect(output).toContain('framework__describe');
  });

  test('shows audit flag for capabilities with audit configured', async () => {
    const output = await run('capabilities');
    // web__fetch declares audit: AuditFull in the dev-app demo
    const webLine = output.split('\n').find((l) => l.includes('web__fetch'));
    expect(webLine).toContain('[audited]');
  });

  test('groups capabilities by namespace', async () => {
    const output = await run('capabilities');
    expect(output).toContain('  web:');
    expect(output).toContain('  system:');
    expect(output).toContain('  framework:');
  });

  test('JSON output returns capability metadata array', async () => {
    const output = await run('capabilities --json');
    const data = JSON.parse(output);
    expect(Array.isArray(data)).toBe(true);
    const names = data.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(['framework__describe', 'system__time', 'web__fetch']);
    const web = data.find((c: { name: string }) => c.name === 'web__fetch');
    expect(web.audited).toBe(true);
    expect(web.tags).toContain('web');
  });
});

describe('capability command', () => {
  test('shows details for a known capability', async () => {
    const output = await run('capability web__fetch');
    expect(output).toContain('web__fetch');
    expect(output).toContain('Fetch a URL');
    expect(output).toContain('Input fields:');
    expect(output).toContain('url');
    expect(output).toContain('(required)');
  });

  test('shows output schema when declared', async () => {
    const output = await run('capability web__fetch');
    expect(output).toContain('Output fields:');
    expect(output).toContain('status');
    expect(output).toContain('truncated');
  });

  test('shows settings line when audit is configured', async () => {
    const output = await run('capability web__fetch');
    expect(output).toContain('Settings:');
    expect(output).toContain('audited');
  });

  test('reports unknown capability cleanly', async () => {
    const output = await run('capability nonexistent__call');
    expect(output).toContain('unknown capability');
  });

  test('requires a capability name', async () => {
    const output = await run('capability');
    expect(output).toContain('capability name is required');
  });

  test('JSON output exposes structured schema', async () => {
    const output = await run('capability web__fetch --json');
    const data = JSON.parse(output);
    expect(data.name).toBe('web__fetch');
    expect(data.audited).toBe(true);
    expect(data.inputSchema.url.kind).toBe('str');
    expect(data.inputSchema.url.required).toBe(true);
  });
});

describe('call command', () => {
  test('invokes system__time and returns ISO string', async () => {
    const output = await run('call system__time');
    const data = JSON.parse(output);
    expect(typeof data.iso).toBe('string');
    expect(data.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('JSON output wraps response in AgentResponse shape', async () => {
    const output = await run('call system__time --json');
    const res = JSON.parse(output);
    expect(res.ok).toBe(true);
    expect(res.data.iso).toMatch(/^\d{4}-/);
  });

  test('rejects missing required input clearly', async () => {
    const output = await run('call web__fetch');
    expect(output).toContain('Error');
    expect(output).toContain("requires field 'url'");
  });

  test('reports unknown capability', async () => {
    const output = await run('call nonexistent__call');
    expect(output).toContain("unknown capability 'nonexistent__call'");
  });

  test('requires a capability name', async () => {
    const output = await run('call');
    expect(output).toContain('capability name is required');
  });

  test('passes flag values through to the handler', async () => {
    const output = await run('call web__fetch --url "data:text/plain,hello"');
    const data = JSON.parse(output);
    expect(data.body).toBe('hello');
    expect(data.ok).toBe(true);
  });
});

describe('help includes capability commands', () => {
  test('mentions capabilities, capability, and call', async () => {
    const output = await run('help');
    expect(output).toContain('capabilities');
    expect(output).toContain('capability <name>');
    expect(output).toContain('call <name>');
  });
});
