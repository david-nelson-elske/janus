/**
 * @janus/agent-mcp — Model Context Protocol adapter.
 *
 * Walks the compiled registry's capabilities and registers each as an MCP
 * tool, so a single defineCapability() declaration is callable from
 * in-process code, the Janus agent loop, and any MCP client.
 */

export { buildMcpServer, plannedToolCount } from './server';
export type { BuildMcpServerConfig } from './server';
export { semanticToZodShape } from './semantic-to-zod';
