/**
 * Participation for governance entities: committee, committee_term,
 * committee_response, planning_case
 */
import { participate } from '@janus/core';
import { AuditFull } from '@janus/vocabulary';
import { committee, committee_term, committee_response, planning_case } from '../entities';

export const committeeParticipation = participate(committee, {
  policy: {
    rules: [{ role: 'admin', operations: '*' }],
    anonymousRead: true,
  },
  audit: AuditFull,
});

export const committeeTermParticipation = participate(committee_term, {
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'member', operations: ['read'] },
    ],
  },
  audit: AuditFull,
});

export const committeeResponseParticipation = participate(committee_response, {
  policy: {
    rules: [{ role: 'admin', operations: '*' }],
    anonymousRead: true,
  },
  audit: AuditFull,
});

export const planningCaseParticipation = participate(planning_case, {
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'system', operations: ['create', 'update'] },
    ],
    anonymousRead: true,
  },
  audit: AuditFull,
});
