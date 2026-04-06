#!/usr/bin/env bun
/**
 * Seed the demo database with development tracking data.
 *
 * Loads all ADR-124 sub-documents for full-text search testing.
 * Run: bun packages/dev/seed.ts
 */

import { boot } from './app';
import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const ADR_DIR = 'docs/decisions/124-participation-model';

function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/** Extract title from markdown frontmatter or first heading */
function extractTitle(content: string, filename: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return filename.replace('.md', '');
}

async function seed() {
  const app = await boot();
  const { runtime } = app;
  const d = (entity: string, op: string, input: Record<string, unknown>) =>
    runtime.dispatch('system', entity, op, input);

  console.log('Seeding demo database...\n');

  // ── ADR-124 index (parent record) ───────────────────────────

  const indexContent = readFile(join(ADR_DIR, 'index.md'));

  const adrRes = await d('adr', 'create', {
    number: 124,
    title: 'Participation Model — Entity-Mediated Pipeline Wiring',
    summary: 'Four core tables, three wiring domains, five consumer functions. Entities wire to infrastructure through participation records. Pipeline assembly via initiator join.',
    content: indexContent || 'See docs/decisions/124-participation-model/index.md',
  });
  const parentId = (adrRes.data as Record<string, unknown>).id as string;
  console.log(`  ADR-124 created: ${parentId}`);
  await d('adr', 'accepted', { id: parentId });

  // ── Load all sub-ADRs ───────────────────────────────────────

  const files = readdirSync(ADR_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'index.md' && f !== 'ROADMAP.md')
    .sort();

  let subCount = 0;
  for (const file of files) {
    const content = readFile(join(ADR_DIR, file));
    if (!content) continue;

    const section = file.replace('.md', '');
    const title = extractTitle(content, file);

    await d('adr', 'create', {
      number: 124,
      section,
      title,
      content,
      parent: parentId,
    });
    subCount++;
  }
  console.log(`  ${subCount} sub-ADRs loaded`);

  // Also load ROADMAP.md
  const roadmapContent = readFile(join(ADR_DIR, 'ROADMAP.md'));
  if (roadmapContent) {
    await d('adr', 'create', {
      number: 124,
      section: 'ROADMAP',
      title: 'ADR-124 Implementation Roadmap',
      content: roadmapContent,
      parent: parentId,
    });
    console.log('  ROADMAP loaded');
  }

  // ── Tasks ───────────────────────────────────────────────────

  const completedTasks = [
    { title: 'M1: Hello Entity', description: '112 tests. Types, handler registry, define(), participate(), compile() with initiator join.' },
    { title: 'M2: Hello Dispatch', description: '46 tests. Memory + SQLite adapters, pipeline concerns, createDispatchRuntime(). Full CRUD roundtrip.' },
    { title: 'M3: Hello CLI', description: '22 tests. Demo entities, boot sequence, CLI with full command set.' },
    { title: 'M4: Hello Audit', description: 'Identity metadata, policy-lookup, invariant-check, broker, emit-broker, audit-relational, observe-memory, execution_log.' },
    { title: 'M5: Hello Search', description: 'FTS5 in SQLite adapter, query_field on CompileResult, --search CLI flag.' },
    { title: 'M6: Hello HTTP', description: '33 tests. Hono HTTP surface, route derivation, createApp(), REST API.' },
    { title: 'M7: Hello Subscriptions', description: '13 tests. Broker subscriptions, scheduler, tracked subscriptions, dispatch-adapter.' },
    { title: 'M8-core: Hello Binding (core)', description: '15 tests. bind(), binding index, FieldState + BindingContext with @preact/signals-core.' },
    { title: 'M8-render: Hello Binding (render)', description: '71 tests. Preact SSR, SSE sync, connection manager, broker bridge, demo components.' },
    { title: 'M9: Hello Agent Surface', description: 'Agent surface, session entity, tool discovery.' },
    { title: 'ADR 01d: Wiring effects', description: 'Cascade/restrict cross-entity lifecycle effects.' },
    { title: 'ADR 04c: Schema reconciliation', description: 'Schema migration beyond manual rm janus.db.' },
  ];

  for (const t of completedTasks) {
    const res = await d('task', 'create', { ...t, priority: 'high', adr: parentId });
    const id = (res.data as Record<string, unknown>).id as string;
    await d('task', 'in_progress', { id });
    await d('task', 'completed', { id });
  }
  console.log(`  ${completedTasks.length} tasks completed`);

  const pendingTasks = [
    { title: 'ADR 07c: Connectors', description: 'External system integration.', priority: 'medium' },
    { title: 'ADR 08b: Assets and media', description: 'File uploads and binary asset handling.', priority: 'medium' },
    { title: 'ADR 10b: Template rendering', description: 'Template column type and rendered output for notifications.', priority: 'low' },
    { title: 'Harden test coverage', description: 'Fill gaps in M5, M7, subscriptions, and search test suites.', priority: 'medium' },
  ];

  for (const t of pendingTasks) {
    await d('task', 'create', { ...t, adr: parentId });
  }
  console.log(`  ${pendingTasks.length} tasks pending`);

  // ── Questions ───────────────────────────────────────────────

  const questions = [
    { title: 'When does persist_routing become a real Derived entity?', context: 'Currently compile() hardcodes routing. ADR says persist_routing should be browseable.' },
    { title: 'How does Janus integrate with Claude Code via MCP vs CLI?', context: 'CLI is M3 bridge. MCP is future (ADR 13). Both can coexist.' },
  ];

  for (const q of questions) {
    await d('question', 'create', { ...q, adr: parentId });
  }
  console.log(`  ${questions.length} questions`);

  // ── Test run ────────────────────────────────────────────────

  await d('test_run', 'create', {
    suite: 'packages/next-next',
    passed: 609,
    failed: 0,
    skipped: 0,
    duration: 273,
    commit: 'latest',
    timestamp: new Date().toISOString(),
  });
  console.log('  Test run recorded');

  console.log('\nDone. Database: packages/dev/janus.db');
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
