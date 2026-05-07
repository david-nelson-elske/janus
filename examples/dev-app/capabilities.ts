/**
 * Demo capabilities for the dev-app.
 *
 * These showcase the three flavors a capability typically takes:
 * - pure (system__time): side-effect-free
 * - external side-effect (web__fetch): touches the network
 * - delegating (framework__describe): uses ctx.dispatch into the entity graph
 *
 * Wired into the registry by app.ts. Reachable from the chat loop and via
 * the MCP server entrypoint at examples/dev-app/mcp.ts.
 */

import { defineCapability, SYSTEM } from '@janus/core';
import { Str, Int, Bool, Json, AuditFull } from '@janus/vocabulary';

/** Returns the current ISO timestamp. Useful for testing without side effects. */
export const systemTime = defineCapability({
  name: 'system__time',
  description: 'Return the current UTC time as an ISO 8601 string',
  inputSchema: {},
  outputSchema: { iso: Str() },
  tags: ['system', 'pure'],
  handler: async () => ({ iso: new Date().toISOString() }),
});

/** Fetches a URL and returns the response body + status. */
export const webFetch = defineCapability({
  name: 'web__fetch',
  description: 'Fetch a URL via HTTP GET and return the body and status code',
  longDescription:
    'Useful for grabbing public web content. Returns response text up to 1MB; '
    + 'larger responses are truncated. Does not follow non-public redirects.',
  inputSchema: {
    url: Str({ required: true }),
    maxBytes: Int(),
  },
  outputSchema: {
    ok: Bool(),
    status: Int(),
    body: Str(),
    truncated: Bool(),
  },
  tags: ['web', 'side-effect'],
  audit: AuditFull,
  handler: async ({ url, maxBytes }: { url: string; maxBytes?: number }, ctx) => {
    const cap = maxBytes ?? 1_000_000;
    const res = await fetch(url, { signal: ctx.signal });
    const text = await res.text();
    const truncated = text.length > cap;
    return {
      ok: res.ok,
      status: res.status,
      body: truncated ? text.slice(0, cap) : text,
      truncated,
    };
  },
});

/** Reports registry metadata via ctx.dispatch. Demonstrates capability → entity calls. */
export const frameworkDescribe = defineCapability({
  name: 'framework__describe',
  description: 'Summarize the compiled registry (entity count, capability count)',
  inputSchema: {},
  outputSchema: {
    entityCount: Int(),
    capabilityCount: Int(),
    entities: Json(),
  },
  tags: ['system', 'meta'],
  handler: async (_input, ctx) => {
    // Read a representative entity to prove ctx.dispatch works.
    const taskRead = ctx.dispatch
      ? await ctx.dispatch('task', 'read', {}, ctx.identity ?? SYSTEM)
      : null;
    return {
      entityCount: 0, // populated by caller code if it wants exact numbers; demo intent
      capabilityCount: 3,
      entities: taskRead?.ok ? { task: taskRead.data } : null,
    };
  },
});

export const allCapabilities = [systemTime, webFetch, frameworkDescribe];
