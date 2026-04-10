/**
 * Participation for operational entities: task, volunteer_profile,
 * volunteer_position, volunteer_assignment, session_ticket
 */
import { participate } from '@janus/core';
import { AuditFull } from '@janus/vocabulary';
import {
  task, volunteer_profile, volunteer_position,
  volunteer_assignment, session_ticket,
} from '../entities';

export const taskParticipation = participate(task, {
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'member', operations: ['read', 'create', 'update'], ownershipField: 'createdBy' },
    ],
  },
  audit: AuditFull,
});

export const volunteerProfileParticipation = participate(volunteer_profile, {
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'member', operations: ['read', 'create'] },
      { role: 'member', operations: ['update', 'delete'], ownershipField: 'createdBy' },
    ],
  },
  audit: AuditFull,
});

export const volunteerPositionParticipation = participate(volunteer_position, {
  policy: {
    rules: [{ role: 'admin', operations: '*' }],
    anonymousRead: true,
  },
  audit: AuditFull,
});

export const volunteerAssignmentParticipation = participate(volunteer_assignment, {
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'member', operations: ['read', 'create'] },
      { role: 'member', operations: ['update', 'delete'], ownershipField: 'createdBy' },
    ],
  },
  audit: AuditFull,
});

export const sessionTicketParticipation = participate(session_ticket, {
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'member', operations: ['read'] },
    ],
  },
  audit: AuditFull,
});
