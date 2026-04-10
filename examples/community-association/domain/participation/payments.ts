/**
 * Participation for payment entities: order, payment
 */
import { participate } from '@janus/core';
import { AuditFull } from '@janus/vocabulary';
import { order, payment } from '../entities';

export const orderParticipation = participate(order, {
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'system', operations: ['create', 'update'] },
      { role: 'member', operations: ['read'], ownershipField: 'createdBy' },
    ],
  },
  audit: AuditFull,
});

export const paymentParticipation = participate(payment, {
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'system', operations: ['create', 'update'] },
    ],
  },
  audit: AuditFull,
});
