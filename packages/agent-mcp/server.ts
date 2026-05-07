/**
 * MCP server adapter — exposes Janus capabilities (and optionally entity
 * tools) over the Model Context Protocol via @modelcontextprotocol/sdk.
 *
 * One handler / three transports: capabilities defined once with
 * defineCapability() are now callable from in-process code, the Janus
 * agent loop, and any MCP client without duplicated handler logic.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompileResult, Identity } from '@janus/core';
import { SYSTEM } from '@janus/core';
import { discoverCapabilities, dispatchCapability } from '@janus/agent';
import type { DispatchRuntime } from '@janus/pipeline';
import { createRateLimitStore } from '@janus/pipeline';
import { semanticToZodShape } from './semantic-to-zod';

export interface BuildMcpServerConfig {
  /** Compiled registry — source of capabilities to expose. */
  readonly registry: CompileResult;
  /** Dispatch runtime, threaded through capability handlers for nested entity calls. */
  readonly runtime: DispatchRuntime;
  /** Initiator name used for nested entity dispatches. Default: 'agent-surface'. */
  readonly initiator?: string;
  /**
   * Identity for capability invocations. Either a static Identity or a
   * factory called per request (e.g. resolved from MCP session metadata).
   * Default: SYSTEM. The MCP transport authenticates clients separately;
   * the framework trusts whatever identity this resolver returns.
   */
  readonly identity?: Identity | (() => Identity);
  /** MCP server info (advertised on initialize). */
  readonly serverInfo?: { name?: string; version?: string };
  /** Allowlist by capability name. When omitted, every capability is exposed. */
  readonly capabilityNames?: readonly string[];
  /** Allowlist by tag (any-match). Combined with capabilityNames via AND. */
  readonly capabilityTags?: readonly string[];
  /** Hooks for telemetry — fire alongside MCP request handling. */
  readonly onToolCall?: (namespace: string, toolName: string, input: unknown) => void;
  readonly onToolResult?: (
    namespace: string,
    toolName: string,
    result: { ok: boolean; data?: unknown; error?: { kind: string; message: string } },
  ) => void;
}

/**
 * Build an unconnected McpServer with every selected capability registered
 * as an MCP tool. Caller is responsible for connecting a transport
 * (e.g. StdioServerTransport).
 */
export function buildMcpServer(config: BuildMcpServerConfig): McpServer {
  const initiator = config.initiator ?? 'agent-surface';
  const resolveIdentity = (): Identity => {
    if (!config.identity) return SYSTEM;
    return typeof config.identity === 'function' ? config.identity() : config.identity;
  };

  const server = new McpServer({
    name: config.serverInfo?.name ?? 'janus-mcp',
    version: config.serverInfo?.version ?? '0.0.1',
  });

  const capabilities = discoverCapabilities(config.registry, {
    include: config.capabilityNames,
    tags: config.capabilityTags,
  });

  // Shared per-server rate-limit store. Same lifetime as the McpServer
  // instance so reconnecting clients keep their existing counters.
  const rateLimitStore = createRateLimitStore();

  for (const cap of capabilities) {
    const inputShape = semanticToZodShape(cap.inputSchema);
    const outputShape = cap.outputSchema ? semanticToZodShape(cap.outputSchema) : undefined;

    server.registerTool(
      cap.name,
      {
        title: cap.name,
        description: cap.longDescription ?? cap.description,
        inputSchema: inputShape,
        ...(outputShape ? { outputSchema: outputShape } : {}),
      },
      async (args, extra) => {
        const response = await dispatchCapability({
          cap,
          input: args,
          identity: resolveIdentity(),
          runtime: config.runtime,
          initiator,
          onToolCall: config.onToolCall,
          onToolResult: config.onToolResult,
          // MCP SDK supplies an AbortSignal on every tool callback that
          // fires when the client cancels the request. Forward it so
          // long-running capability handlers can bail out cooperatively.
          signal: extra.signal,
          rateLimitStore,
          registry: config.registry,
        });

        if (!response.ok) {
          // The SDK auto-converts thrown errors to isError responses, but we
          // want the structured error payload from dispatchCapability.
          const message = response.error?.message ?? 'capability error';
          return {
            content: [{ type: 'text', text: JSON.stringify(response) }],
            isError: true,
            _meta: { error: response.error },
          };
        }

        const text = JSON.stringify(response.data ?? null);
        return {
          content: [{ type: 'text', text }],
          ...(outputShape && response.data && typeof response.data === 'object'
            ? { structuredContent: response.data as Record<string, unknown> }
            : {}),
        };
      },
    );
  }

  return server;
}

/**
 * Total number of capabilities the server would register given its config.
 * Useful for tests and startup logging.
 */
export function plannedToolCount(config: BuildMcpServerConfig): number {
  return discoverCapabilities(config.registry, {
    include: config.capabilityNames,
    tags: config.capabilityTags,
  }).length;
}

/**
 * One-liner: build an MCP server, connect it on stdio, and resolve once
 * the transport is open. Use this when standing up a Claude Code Remote
 * Control adapter or any other stdio-MCP entrypoint:
 *
 *   await serveCapabilitiesOnStdio({ registry, runtime });
 *
 * For non-stdio transports or post-connect inspection, call buildMcpServer
 * directly and connect your own transport.
 */
export async function serveCapabilitiesOnStdio(
  config: BuildMcpServerConfig,
): Promise<{ server: McpServer; close: () => Promise<void> }> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = buildMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    server,
    close: async () => {
      await server.close();
    },
  };
}
