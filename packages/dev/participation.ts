/**
 * Demo app participation — pipeline wiring for demo entities.
 */

import { participate } from '@janus/core';
import { AuditFull } from '@janus/vocabulary';
import { adr, task, test_run, question, task_summary } from './entities';

export const adrParticipation = participate(adr, { audit: AuditFull });
export const taskParticipation = participate(task, { audit: AuditFull });
export const testRunParticipation = participate(test_run, {});
export const questionParticipation = participate(question, { audit: AuditFull });
export const taskSummaryParticipation = participate(task_summary, {});

export const allParticipations = [
  adrParticipation,
  taskParticipation,
  testRunParticipation,
  questionParticipation,
  taskSummaryParticipation,
];
