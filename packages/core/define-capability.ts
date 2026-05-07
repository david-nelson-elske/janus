/**
 * defineCapability() — Capability declaration.
 *
 * Pure function that returns a frozen CapabilityResult. No side effects, no
 * global registration. Capabilities are operations whose shape is "typed
 * input → handler → typed output" — peer to define()/participate() for things
 * that are not entity-shaped (Drive search, web fetch, sync commands, etc.).
 */

import type {
  CapabilityConfig,
  CapabilityRecord,
  CapabilityResult,
  SchemaField,
} from './types';
import { CAPABILITY_NAME, FIELD_NAME, MAX_CAPABILITY_NAME_LENGTH } from './types';

function validateCapabilityName(name: string): void {
  if (!name) {
    throw new Error('Capability name must not be empty');
  }
  if (name.length > MAX_CAPABILITY_NAME_LENGTH) {
    throw new Error(
      `Capability name must be at most ${MAX_CAPABILITY_NAME_LENGTH} characters, got ${name.length}`,
    );
  }
  if (!CAPABILITY_NAME.test(name)) {
    throw new Error(
      `Invalid capability name '${name}': must match ${CAPABILITY_NAME} ` +
        `(format: namespace__verb, lowercase alphanumeric + underscores)`,
    );
  }
}

function validateFieldNames(schema: Readonly<Record<string, SchemaField>>, label: string): void {
  for (const field of Object.keys(schema)) {
    if (!FIELD_NAME.test(field)) {
      throw new Error(
        `Invalid ${label} field name '${field}': must match ${FIELD_NAME}`,
      );
    }
  }
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

export function defineCapability<TInput = unknown, TOutput = unknown>(
  config: CapabilityConfig<TInput, TOutput>,
): CapabilityResult {
  validateCapabilityName(config.name);

  if (!config.description) {
    throw new Error(`Capability '${config.name}' requires a description`);
  }
  if (!config.inputSchema || typeof config.inputSchema !== 'object') {
    throw new Error(`Capability '${config.name}' requires an inputSchema`);
  }
  if (typeof config.handler !== 'function') {
    throw new Error(`Capability '${config.name}' requires a handler function`);
  }

  validateFieldNames(config.inputSchema, 'inputSchema');
  if (config.outputSchema) {
    validateFieldNames(config.outputSchema, 'outputSchema');
  }

  const record: CapabilityRecord = {
    name: config.name,
    description: config.description,
    longDescription: config.longDescription,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    handler: config.handler as CapabilityRecord['handler'],
    policy: config.policy,
    rateLimit: config.rateLimit,
    audit: config.audit,
    observe: config.observe,
    auditRedact: config.auditRedact ? Object.freeze([...config.auditRedact]) : undefined,
    tags: config.tags ? Object.freeze([...config.tags]) : undefined,
  };

  return deepFreeze({ kind: 'capability' as const, record });
}
