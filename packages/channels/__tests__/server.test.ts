/**
 * Smoke tests for the channel SSE bridge server module.
 */

import { describe, expect, it } from 'bun:test';
import { parseSubscriptionsFromQuery } from '../server';

describe('parseSubscriptionsFromQuery', () => {
  it('parses channel-only subscriptions', () => {
    const params = new URLSearchParams('sub=decision-updated');
    const subs = parseSubscriptionsFromQuery(params);
    expect(subs).toEqual([{ channel: 'decision-updated', scope: {} }]);
  });

  it('parses scoped subscriptions', () => {
    const params = new URLSearchParams('sub=decision-updated:decisionId=d_42');
    const subs = parseSubscriptionsFromQuery(params);
    expect(subs).toEqual([
      { channel: 'decision-updated', scope: { decisionId: 'd_42' } },
    ]);
  });

  it('parses multi-key scopes', () => {
    const params = new URLSearchParams(
      'sub=chat-message-posted:memberId=m_1,decisionId=d_42',
    );
    const subs = parseSubscriptionsFromQuery(params);
    expect(subs).toEqual([
      {
        channel: 'chat-message-posted',
        scope: { memberId: 'm_1', decisionId: 'd_42' },
      },
    ]);
  });

  it('parses multiple sub params', () => {
    const params = new URLSearchParams(
      'sub=decision-updated:decisionId=d_1&sub=round-updated:roundId=r_5',
    );
    const subs = parseSubscriptionsFromQuery(params);
    expect(subs).toHaveLength(2);
    expect(subs[0]).toEqual({ channel: 'decision-updated', scope: { decisionId: 'd_1' } });
    expect(subs[1]).toEqual({ channel: 'round-updated', scope: { roundId: 'r_5' } });
  });

  it('returns empty when no sub params', () => {
    const params = new URLSearchParams('foo=bar');
    expect(parseSubscriptionsFromQuery(params)).toEqual([]);
  });
});
