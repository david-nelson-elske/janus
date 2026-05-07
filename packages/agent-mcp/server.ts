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
      async (args) => {
        const response = await dispatchCapability({
          cap,
          input: args,
          identity: resolveIdentity(),
          runtime: config.runtime,
          initiator,
          onToolCall: config.onToolCall,
          onToolResult: config.onToolResult,
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
