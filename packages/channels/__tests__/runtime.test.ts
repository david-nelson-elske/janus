/**
 * Smoke tests for the channel runtime. Exercises:
 *
 *  - declareChannel validates shape (name, payload, scope, persist)
 *  - publish validates payload + scope against the declaration
 *  - subscribe filters by scope (matching / mismatching / wildcard)
 *  - bridge sinks fire on every publish
 *  - persistence sink fires only for logged channels
 *
 * Designed to run with `bun test`. No external dependencies.
 */

import { describe, expect, it } from 'bun:test';
import {
  createChannelBroker,
  declareChannel,
  type ChannelEvent,
} from '..';

const decisionUpdated = declareChannel({
  name: 'decision-updated',
  payload: {
    decisionId: 'string',
    kind: 'enum:created|updated|deleted',
  } as const,
  scope: { decisionId: 'string' } as const,
  publishers: ['system'] as const,
  subscribers: ['controller'] as const,
  persist: 'transient',
  description: 'test channel',
});

const loggedChannel = declareChannel({
  name: 'logged-channel',
  payload: { decisionId: 'string' } as const,
  scope: { decisionId: 'string' } as const,
  publishers: ['system'] as const,
  subscribers: ['controller'] as const,
  persist: 'logged',
  description: 'logged test channel',
});

describe('declareChannel', () => {
  it('rejects non-kebab names', () => {
    expect(() =>
      declareChannel({
        name: 'BadName',
        payload: { x: 'string' } as const,
        scope: {} as const,
        publishers: [],
        subscribers: [],
        persist: 'transient',
        description: 'x',
      }),
    ).toThrow(/kebab-case/);
  });

  it('requires scope keys to appear in payload', () => {
    expect(() =>
      declareChannel({
        name: 'bad-scope',
        payload: { x: 'string' } as const,
        scope: { y: 'string' } as const,
        publishers: [],
        subscribers: [],
        persist: 'transient',
        description: 'x',
      }),
    ).toThrow(/must also appear in payload/);
  });

  it('requires a non-empty description', () => {
    expect(() =>
      declareChannel({
        name: 'no-desc',
        payload: { x: 'string' } as const,
        scope: {} as const,
        publishers: [],
        subscribers: [],
        persist: 'transient',
        description: '',
      }),
    ).toThrow(/description is required/);
  });

  it('accepts enum payload types', () => {
    const decl = declareChannel({
      name: 'enum-channel',
      payload: { kind: 'enum:a|b|c' } as const,
      scope: {} as const,
      publishers: [],
      subscribers: [],
      persist: 'transient',
      description: 'x',
    });
    expect(decl.name).toBe('enum-channel');
  });
});

describe('publish + subscribe', () => {
  it('delivers to matching scope subscribers', () => {
    const broker = createChannelBroker({ 'decision-updated': decisionUpdated });
    const received: ChannelEvent[] = [];
    broker.subscribe(decisionUpdated, {
      scope: { decisionId: 'd_1' },
      handler: (evt) => received.push(evt as ChannelEvent),
    });
    broker.publish(decisionUpdated, {
      scope: { decisionId: 'd_1' },
      payload: { decisionId: 'd_1', kind: 'updated' },
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.payload.decisionId).toBe('d_1');
  });

  it('drops events that do not match scope', () => {
    const broker = createChannelBroker({ 'decision-updated': decisionUpdated });
    const received: ChannelEvent[] = [];
    broker.subscribe(decisionUpdated, {
      scope: { decisionId: 'd_1' },
      handler: (evt) => received.push(evt as ChannelEvent),
    });
    broker.publish(decisionUpdated, {
      scope: { decisionId: 'd_other' },
      payload: { decisionId: 'd_other', kind: 'updated' },
    });
    expect(received).toHaveLength(0);
  });

  it('wildcard subscriber receives every event', () => {
    const broker = createChannelBroker({ 'decision-updated': decisionUpdated });
    const received: ChannelEvent[] = [];
    broker.subscribe(decisionUpdated, {
      scope: {},
      handler: (evt) => received.push(evt as ChannelEvent),
    });
    broker.publish(decisionUpdated, {
      scope: { decisionId: 'd_1' },
      payload: { decisionId: 'd_1', kind: 'updated' },
    });
    broker.publish(decisionUpdated, {
      scope: { decisionId: 'd_2' },
      payload: { decisionId: 'd_2', kind: 'updated' },
    });
    expect(received).toHaveLength(2);
  });

  it('rejects publish with bad payload type', () => {
    const broker = createChannelBroker({ 'decision-updated': decisionUpdated });
    expect(() =>
      broker.publish(decisionUpdated, {
        scope: { decisionId: 'd_1' },
        // @ts-expect-error — intentionally wrong type
        payload: { decisionId: 123, kind: 'updated' },
      }),
    ).toThrow(/wrong type/);
  });

  it('rejects publish with bad enum value', () => {
    const broker = createChannelBroker({ 'decision-updated': decisionUpdated });
    expect(() =>
      broker.publish(decisionUpdated, {
        scope: { decisionId: 'd_1' },
        // @ts-expect-error — intentionally bad enum
        payload: { decisionId: 'd_1', kind: 'frobnicated' },
      }),
    ).toThrow(/wrong type/);
  });

  it('rejects subscribe with unknown scope key', () => {
    const broker = createChannelBroker({ 'decision-updated': decisionUpdated });
    expect(() =>
      broker.subscribe(decisionUpdated, {
        // @ts-expect-error — unknown scope key
        scope: { otherKey: 'x' },
        handler: () => {},
      }),
    ).toThrow(/unknown scope key/);
  });

  it('unsubscribe stops further delivery', () => {
    const broker = createChannelBroker({ 'decision-updated': decisionUpdated });
    const received: ChannelEvent[] = [];
    const unsub = broker.subscribe(decisionUpdated, {
      scope: { decisionId: 'd_1' },
      handler: (evt) => received.push(evt as ChannelEvent),
    });
    broker.publish(decisionUpdated, {
      scope: { decisionId: 'd_1' },
      payload: { decisionId: 'd_1', kind: 'updated' },
    });
    unsub();
    broker.publish(decisionUpdated, {
      scope: { decisionId: 'd_1' },
      payload: { decisionId: 'd_1', kind: 'updated' },
    });
    expect(received).toHaveLength(1);
  });
});

describe('bridge sinks', () => {
  it('fire on every publish regardless of scope', () => {
    const broker = createChannelBroker({ 'decision-updated': decisionUpdated });
    const sinkEvents: ChannelEvent[] = [];
    broker.registerBridgeSink((evt) => sinkEvents.push(evt));
    broker.publish(decisionUpdated, {
      scope: { decisionId: 'd_1' },
      payload: { decisionId: 'd_1', kind: 'updated' },
    });
    broker.publish(decisionUpdated, {
      scope: { decisionId: 'd_2' },
      payload: { decisionId: 'd_2', kind: 'updated' },
    });
    expect(sinkEvents).toHaveLength(2);
  });

  it('unsubscribe stops future fan-out to sink', () => {
    const broker = createChannelBroker({ 'decision-updated': decisionUpdated });
    const sinkEvents: ChannelEvent[] = [];
    const unsub = broker.registerBridgeSink((evt) => sinkEvents.push(evt));
    broker.publish(decisionUpdated, {
      scope: { decisionId: 'd_1' },
      payload: { decisionId: 'd_1', kind: 'updated' },
    });
    unsub();
    broker.publish(decisionUpdated, {
      scope: { decisionId: 'd_1' },
      payload: { decisionId: 'd_1', kind: 'updated' },
    });
    expect(sinkEvents).toHaveLength(1);
  });
});

describe('persistence', () => {
  it('logged channels invoke the persistence sink', async () => {
    const broker = createChannelBroker({ 'logged-channel': loggedChannel });
    const persisted: ChannelEvent[] = [];
    broker.setPersistenceSink((evt) => {
      persisted.push(evt);
    });
    broker.publish(loggedChannel, {
      scope: { decisionId: 'd_1' },
      payload: { decisionId: 'd_1' },
    });
    expect(persisted).toHaveLength(1);
  });

  it('transient channels do not persist', () => {
    const broker = createChannelBroker({ 'decision-updated': decisionUpdated });
    const persisted: ChannelEvent[] = [];
    broker.setPersistenceSink((evt) => {
      persisted.push(evt);
    });
    broker.publish(decisionUpdated, {
      scope: { decisionId: 'd_1' },
      payload: { decisionId: 'd_1', kind: 'updated' },
    });
    expect(persisted).toHaveLength(0);
  });
});
