/**
 * Participation for garden entities: garden_bed, garden_assignment, garden_log
 */
import { participate } from '@janus/core';
import { AuditFull } from '@janus/vocabulary';
import { garden_bed, garden_assignment, garden_log } from '../entities';

export const gardenBedParticipation = participate(garden_bed, {
  policy: {
    rules: [{ role: 'admin', operations: '*' }],
    anonymousRead: true,
  },
  audit: AuditFull,
});

export const gardenAssignmentParticipation = participate(garden_assignment, {
  policy: {
    rules: [{ role: 'admin', operations: '*' }],
    anonymousRead: true,
  },
  audit: AuditFull,
});

export const gardenLogParticipation = participate(garden_log, {
  policy: {
    rules: [{ role: 'admin', operations: '*' }],
    anonymousRead: true,
  },
  audit: AuditFull,
});
