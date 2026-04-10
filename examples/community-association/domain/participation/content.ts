/**
 * Participation for content entities: content, news_item
 */
import { participate } from '@janus/core';
import { AuditFull } from '@janus/vocabulary';
import { content, news_item } from '../entities';

export const contentParticipation = participate(content, {
  policy: {
    rules: [{ role: 'admin', operations: '*' }],
    anonymousRead: true,
  },
  audit: AuditFull,
});

export const newsItemParticipation = participate(news_item, {
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'system', operations: ['create', 'update'] },
    ],
    anonymousRead: true,
  },
  audit: AuditFull,
});
