/**
 * Convert Janus semantic-type schemas (Record<string, SchemaField>) to a
 * Zod raw shape that the MCP TypeScript SDK accepts on registerTool().
 *
 * The MCP SDK requires Zod for tool inputs (1.29.0); raw JSON Schema is
 * not accepted on registerTool. This module is the boundary translator.
 */

import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import type { SchemaField } from '@janus/core';
import { isSemanticField } from '@janus/vocabulary';

function leafFor(field: SchemaField): ZodTypeAny {
  if (!isSemanticField(field)) {
    return z.unknown();
  }
  switch (field.kind) {
    case 'str':
    case 'markdown':
    case 'email':
    case 'token':
    case 'qrcode':
    case 'id':
      return z.string();
    case 'datetime':
      return z.string();
    case 'enum': {
      const values = (field as unknown as { values: readonly string[] }).values;
      if (!values?.length) return z.string();
      return z.enum(values as [string, ...string[]]);
    }
    case 'int':
    case 'duration':
    case 'intcents':
    case 'intbps':
      return z.number().int();
    case 'float':
      return z.number();
    case 'bool':
      return z.boolean();
    case 'json':
      return z.unknown();
    default:
      return z.unknown();
  }
}

/**
 * Convert a Janus field schema to a Zod raw shape suitable for
 * `McpServer.registerTool({ inputSchema: ... })`.
 *
 * Required fields stay required; everything else becomes `.optional()`.
 * The SDK wraps the shape in z.object() internally.
 */
export function semanticToZodShape(
  schema: Readonly<Record<string, SchemaField>>,
): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, field] of Object.entries(schema)) {
    const leaf = leafFor(field);
    const required = isSemanticField(field) && field.hints?.required === true;
    shape[name] = required ? leaf : leaf.optional();
  }
  return shape;
}
