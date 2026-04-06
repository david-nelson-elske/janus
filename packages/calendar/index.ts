/**
 * @janus/calendar — Calendar domain knowledge.
 *
 * Pure functions for RRULE expansion, iCal serialization/parsing,
 * and availability validation. No framework dependencies.
 */

export { parseRRule, expandRRule } from './rrule';
export type { ParsedRRule, ExpandOptions } from './rrule';

export { serializeICalFeed, ICAL_CONTENT_TYPE } from './ical';
export type { ICalEvent, ICalFeedOptions } from './ical';

export { parseICalFeed } from './ical-parse';
export type { ParsedICalEvent } from './ical-parse';

export { checkAvailability } from './availability';
export type {
  AvailabilityData,
  AvailabilityWindow,
  AvailabilityCheckResult,
  AvailabilityConstraints,
  AvailabilityViolation,
  ExistingBooking,
} from './availability';
