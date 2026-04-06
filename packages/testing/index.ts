/**
 * @janus/testing — Test harness and proof entities.
 *
 * One-liner test setup that replaces the 10+ lines of boilerplate
 * every test file currently repeats.
 */

export { createTestHarness } from './harness';
export type { TestHarness, TestHarnessConfig } from './harness';
export { proofEntities, Note, User, Venue, Event, Registration } from './proof-entities';
