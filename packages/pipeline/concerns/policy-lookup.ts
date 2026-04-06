/**
 * policy-lookup — Authorization via hash-map rule evaluation.
 *
 * Reads PolicyConfig from participation record config. Checks identity roles
 * against rules. Sets policyOwnershipField on context for validate to enforce.
 *
 * STABLE — ADR 05 invariant. No IO for the common case (hash-map lookup).
 */

import type { ExecutionHandler } from '@janus/core';
import { ANONYMOUS } from '@janus/core';

interface PolicyRule {
  readonly role: string;
  readonly operations: '*' | readonly string[];
  readonly ownershipField?: string;
}

interface PolicyConfig {
  readonly rules: readonly PolicyRule[];
  readonly anonymousRead?: boolean;
}

export const policyLookup: ExecutionHandler = async (ctx) => {
  const config = ctx.config as unknown as PolicyConfig;
  if (!config || !config.rules) return; // no policy configured — allow all

  const identity = ctx.identity;
  const operation = ctx.operation;

  // Anonymous read shortcut
  if (config.anonymousRead && operation === 'read' && identity.id === ANONYMOUS.id) {
    return;
  }

  // Anonymous users denied for non-read or when anonymousRead is false
  if (identity.id === ANONYMOUS.id) {
    throw Object.assign(
      new Error(`Anonymous access denied for ${ctx.entity}:${operation}`),
      { kind: 'auth-error', retryable: false },
    );
  }

  // Find matching rule: role in identity.roles AND operation matches
  const matchingRule = config.rules.find((rule) => {
    if (!identity.roles.includes(rule.role)) return false;
    if (rule.operations === '*') return true;
    return rule.operations.includes(operation);
  });

  if (!matchingRule) {
    throw Object.assign(
      new Error(`Access denied: ${identity.id} (roles: ${identity.roles.join(',')}) cannot ${operation} on ${ctx.entity}`),
      { kind: 'auth-error', retryable: false },
    );
  }

  // Set ownership field for validate to enforce
  if (matchingRule.ownershipField) {
    ctx.policyOwnershipField = matchingRule.ownershipField;
  }
};
