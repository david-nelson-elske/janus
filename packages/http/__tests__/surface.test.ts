/**
 * Tests for apiSurface() constructor.
 */

import { describe, expect, test } from 'bun:test';
import { apiSurface } from '..';

describe('apiSurface', () => {
  test('returns default name and basePath', () => {
    const s = apiSurface();
    expect(s.initiator.name).toBe('api-surface');
    expect(s.basePath).toBe('/api');
  });

  test('respects custom name and basePath', () => {
    const s = apiSurface({ name: 'custom', basePath: '/v2' });
    expect(s.initiator.name).toBe('custom');
    expect(s.basePath).toBe('/v2');
  });

  test('produces three participation records', () => {
    const s = apiSurface();
    expect(s.initiator.participations).toHaveLength(3);

    const handlers = s.initiator.participations!.map((p) => p.handler);
    expect(handlers).toContain('http-receive');
    expect(handlers).toContain('http-identity');
    expect(handlers).toContain('http-respond');
  });

  test('participation orders are correct', () => {
    const s = apiSurface();
    const byHandler = Object.fromEntries(
      s.initiator.participations!.map((p) => [p.handler, p]),
    );
    expect(byHandler['http-receive'].order).toBe(5);
    expect(byHandler['http-identity'].order).toBe(6);
    expect(byHandler['http-respond'].order).toBe(80);
  });

  test('all participations are non-transactional', () => {
    const s = apiSurface();
    for (const p of s.initiator.participations!) {
      expect(p.transactional).toBe(false);
    }
  });

  test('passes identity keys to http-identity config', () => {
    const keys = { 'test-key': { id: 'user1', roles: ['admin'] as readonly string[] } };
    const s = apiSurface({ identity: { keys } });
    const identityP = s.initiator.participations!.find((p) => p.handler === 'http-identity')!;
    expect((identityP.config as any).keys).toBe(keys);
  });

  test('origin is consumer', () => {
    const s = apiSurface();
    expect(s.initiator.origin).toBe('consumer');
  });

  test('passes OIDC config to http-identity config', () => {
    const oidc = { issuer: 'https://auth.example.com/realms/test', clientId: 'my-app' };
    const s = apiSurface({ identity: { oidc } });
    const identityP = s.initiator.participations!.find((p) => p.handler === 'http-identity')!;
    expect((identityP.config as any).oidc).toBe(oidc);
  });

  test('passes both OIDC and keys when both configured', () => {
    const keys = { 'k1': { id: 'u1', roles: ['admin'] as readonly string[] } };
    const oidc = { issuer: 'https://auth.example.com', clientId: 'app' };
    const s = apiSurface({ identity: { keys, oidc } });
    const identityP = s.initiator.participations!.find((p) => p.handler === 'http-identity')!;
    expect((identityP.config as any).keys).toBe(keys);
    expect((identityP.config as any).oidc).toBe(oidc);
  });

  test('OIDC with custom rolesClaim threads through', () => {
    const oidc = {
      issuer: 'https://auth.example.com',
      clientId: 'app',
      rolesClaim: 'groups',
      scopesClaim: 'permissions',
    };
    const s = apiSurface({ identity: { oidc } });
    const identityP = s.initiator.participations!.find((p) => p.handler === 'http-identity')!;
    const config = identityP.config as any;
    expect(config.oidc.rolesClaim).toBe('groups');
    expect(config.oidc.scopesClaim).toBe('permissions');
  });
});
