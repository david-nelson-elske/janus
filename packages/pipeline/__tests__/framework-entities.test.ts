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
} from '..';
import { clearRegistry } from '@janus/core';

afterEach(() => {
  clearRegistry();
});

describe('frameworkEntities', () => {
  test('has 5 entities', () => {
    expect(frameworkEntities).toHaveLength(5);
  });

  test('has 5 participations', () => {
    expect(frameworkParticipations).toHaveLength(5);
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
