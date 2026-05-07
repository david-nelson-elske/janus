/**
 * Unit tests for framework-seeded entity definitions.
 *
 * Exercises: entity count, entity shapes, participation flags,
 * storage strategies, and index configurations.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  frameworkEntities,
  frameworkParticipations,
  executionLog,
  agentSession,
  connectorBinding,
  asset,
  template,
  oidcProvider,
  session,
} from '..';
import { clearRegistry } from '@janus/core';

afterEach(() => {
  clearRegistry();
});

describe('frameworkEntities', () => {
  test('has 8 entities', () => {
    expect(frameworkEntities).toHaveLength(8);
  });

  test('has 8 participations', () => {
    expect(frameworkParticipations).toHaveLength(8);
  });
});

describe('execution_log', () => {
  test('name is execution_log', () => {
    expect(executionLog.record.name).toBe('execution_log');
  });

  test('storage is Persistent', () => {
    expect(executionLog.record.storage.mode).toBe('persistent');
  });

  test('origin is framework', () => {
    expect(executionLog.record.origin).toBe('framework');
  });

  test('has required fields: handler, source, status, timestamp, retention', () => {
    const schema = executionLog.record.schema;
    expect(schema.handler).toBeDefined();
    expect(schema.source).toBeDefined();
    expect(schema.status).toBeDefined();
    expect(schema.timestamp).toBeDefined();
    expect(schema.retention).toBeDefined();
  });
});

describe('agent_session', () => {
  test('name is agent_session', () => {
    expect(agentSession.record.name).toBe('agent_session');
  });

  test('storage is Volatile', () => {
    expect(agentSession.record.storage.mode).toBe('volatile');
  });

  test('origin is framework', () => {
    expect(agentSession.record.origin).toBe('framework');
  });
});

describe('connector_binding', () => {
  test('has unique index on [connector, entity, externalId, externalSource]', () => {
    const indexes = connectorBinding.record.indexes;
    expect(indexes).toBeDefined();
    expect(indexes!.length).toBeGreaterThanOrEqual(1);

    const uniqueIdx = indexes!.find(
      (idx) =>
        idx.unique === true &&
        idx.fields.includes('connector') &&
        idx.fields.includes('entity') &&
        idx.fields.includes('externalId') &&
        idx.fields.includes('externalSource'),
    );
    expect(uniqueIdx).toBeDefined();
  });
});

describe('asset', () => {
  test('owned is true', () => {
    expect(asset.record.owned).toBe(true);
  });

  test('storage is Persistent', () => {
    expect(asset.record.storage.mode).toBe('persistent');
  });

  test('origin is framework', () => {
    expect(asset.record.origin).toBe('framework');
  });
});

describe('template', () => {
  test('has unique index on name', () => {
    const indexes = template.record.indexes;
    expect(indexes).toBeDefined();
    expect(indexes!.length).toBeGreaterThanOrEqual(1);

    const uniqueNameIdx = indexes!.find(
      (idx) => idx.unique === true && idx.fields.includes('name'),
    );
    expect(uniqueNameIdx).toBeDefined();
  });

  test('origin is framework', () => {
    expect(template.record.origin).toBe('framework');
  });
});

describe('oidc_provider', () => {
  test('name is oidc_provider', () => {
    expect(oidcProvider.record.name).toBe('oidc_provider');
  });

  test('storage is Singleton', () => {
    expect(oidcProvider.record.storage.mode).toBe('singleton');
  });

  test('origin is framework', () => {
    expect(oidcProvider.record.origin).toBe('framework');
  });

  test('has OIDC config fields', () => {
    const schema = oidcProvider.record.schema;
    expect(schema.issuer).toBeDefined();
    expect(schema.client_id).toBeDefined();
    expect(schema.client_secret).toBeDefined();
    expect(schema.roles_claim).toBeDefined();
    expect(schema.scope_claim).toBeDefined();
    expect(schema.role_map).toBeDefined();
    expect(schema.identity_entity).toBeDefined();
    expect(schema.subject_field).toBeDefined();
  });

  test('operations are read and update only (singleton)', () => {
    expect(oidcProvider.record.operations).toContain('read');
    expect(oidcProvider.record.operations).toContain('update');
    expect(oidcProvider.record.operations).not.toContain('create');
    expect(oidcProvider.record.operations).not.toContain('delete');
  });
});

describe('session', () => {
  test('name is session', () => {
    expect(session.record.name).toBe('session');
  });

  test('storage is Persistent', () => {
    expect(session.record.storage.mode).toBe('persistent');
  });

  test('origin is framework', () => {
    expect(session.record.origin).toBe('framework');
  });

  test('has auth session fields', () => {
    const schema = session.record.schema;
    expect(schema.subject).toBeDefined();
    expect(schema.identity_id).toBeDefined();
    expect(schema.token).toBeDefined();
    expect(schema.refresh_token).toBeDefined();
    expect(schema.provider).toBeDefined();
    expect(schema.status).toBeDefined();
  });

  test('token field is Token type', () => {
    expect(session.record.schema.token.kind).toBe('token');
  });

  test('status field has lifecycle transitions', () => {
    const lifecycles = session.record.lifecycles;
    expect(lifecycles.length).toBeGreaterThan(0);
    const statusLifecycle = lifecycles.find((l: any) => l.field === 'status');
    expect(statusLifecycle).toBeDefined();
  });

  test('has index on subject', () => {
    const indexes = session.record.indexes;
    expect(indexes).toBeDefined();
    const subjectIdx = indexes!.find((idx: any) => idx.fields.includes('subject'));
    expect(subjectIdx).toBeDefined();
  });
});

describe('all participations have emit=false', () => {
  test('each participation config has emit: false', () => {
    for (const p of frameworkParticipations) {
      // Participation records contain 'emit-broker' handler only when emit is NOT false.
      // When emit is false, there should be no emit-broker handler in the participation records.
      // We check the config that was passed to participate() by verifying
      // no handler with key 'emit-broker' is in the participation records.
      const records = p.records;
      const emitRecords = records.filter((r: any) => r.handler === 'emit-broker');
      expect(emitRecords).toHaveLength(0);
    }
  });
});
