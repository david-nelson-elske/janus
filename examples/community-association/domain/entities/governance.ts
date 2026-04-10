/**
 * Governance entities: committee, committee_term, committee_response, planning_case
 */
import { define } from '@janus/core';
import {
  Str, Int, DateTime, Bool, Email, Url, Asset, Markdown, LatLng,
  Public, Persistent, Relation,
} from '@janus/vocabulary';
import {
  committeeLifecycle, committeeTermLifecycle,
  committeeResponseLifecycle, planningCaseLifecycle,
} from '../lifecycles';

// ── Committee ─────────────────────────────────────────────────────
export const committee = define('committee', {
  schema: Public({
    name: Str({ required: true, as: 'title' }),
    description: Markdown({ as: 'body' }),
    purpose: Str({ as: 'subtitle' }),
    status: committeeLifecycle,
  }),
  storage: Persistent(),
  description: 'Community association committee',
});

// ── Committee Term ────────────────────────────────────────────────
export const committee_term = define('committee_term', {
  schema: Public({
    committeeId: Relation('committee'),
    userId: Relation('user'),
    role: Str({ required: true, as: 'title' }),
    startsAt: DateTime({ required: true, as: 'timestamp' }),
    endsAt: DateTime(),
    status: committeeTermLifecycle,
  }),
  storage: Persistent(),
  description: 'Committee membership term for a user',
});

// ── Committee Response ────────────────────────────────────────────
export const committee_response = define('committee_response', {
  schema: Public({
    title: Str({ required: true, as: 'title' }),
    body: Markdown({ as: 'body' }),
    planningCaseId: Relation('planning_case'),
    committeeId: Relation('committee'),
    document: Asset({ accept: 'application/pdf' }),
    publishedAt: DateTime({ as: 'timestamp' }),
    status: committeeResponseLifecycle,
  }),
  storage: Persistent(),
  description: 'Committee response to a planning case',
});

// ── Planning Case ─────────────────────────────────────────────────
export const planning_case = define('planning_case', {
  schema: Public({
    title: Str({ required: true, as: 'title' }),
    description: Markdown({ as: 'body' }),
    externalType: Str({ as: 'subtitle' }),
    fileNumber: Str(),
    statusDescription: Str(),
    applicant: Str(),
    createdAtExternal: DateTime({ as: 'timestamp' }),
    cityCaseUrl: Url(),
    cityCommentUrl: Url(),
    existingLud: Str(),
    existingLudDescription: Str(),
    proposedLud: Str(),
    decisionAtExternal: DateTime(),
    externalSource: Str({ searchable: false }),
    jobId: Str({ searchable: false }),
    communityName: Str(),
    statusTag: Str({ searchable: false }),
    fileManagerName: Str(),
    fileManagerEmail: Email(),
    fileManagerTitle: Str(),
    lastSyncedAt: DateTime({ searchable: false }),
    relevanceScope: Str(),
    plainLanguageSummary: Markdown({ as: 'summary' }),
    appealBody: Str(),
    location: LatLng({ searchable: false }),
    image: Asset({ accept: 'image/*', as: 'image' }),
    // Inline committee response fields
    responseDisposition: Str(),
    responseComment: Markdown(),
    responseDocument: Asset({ accept: 'application/pdf' }),
    responseSubmitted: Bool(),
    responseRespondedAt: DateTime(),
    responseEditedAt: DateTime(),
    committeeStatus: Str(),
    status: planningCaseLifecycle,
  }),
  storage: Persistent(),
  description: 'City planning/development application',
});
