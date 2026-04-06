/**
 * Minimal RFC 5545 iCalendar parser.
 *
 * Extracts VEVENT components from VCALENDAR text into structured records.
 * Handles property parsing, text unescaping, line unfolding, and datetime
 * conversion. Does NOT handle VTIMEZONE, VALARM, or recurrence expansion.
 */

export interface ParsedICalEvent {
  readonly uid: string;
  readonly summary: string;
  readonly start: number;
  readonly end: number;
  readonly description?: string;
  readonly location?: string;
  readonly category?: string;
  readonly lastModified?: number;
}

function unfoldLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const unfolded = normalized.replace(/\n[ \t]/g, '');
  return unfolded.split('\n').filter((line) => line.length > 0);
}

function unescapeText(text: string): string {
  return text
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseICalDateTime(value: string): number {
  const dateStr = value.includes(':') ? value.split(':').pop()! : value;
  const clean = dateStr.trim();

  if (clean.length === 8) {
    const y = parseInt(clean.slice(0, 4), 10);
    const m = parseInt(clean.slice(4, 6), 10) - 1;
    const d = parseInt(clean.slice(6, 8), 10);
    return Date.UTC(y, m, d);
  }

  const y = parseInt(clean.slice(0, 4), 10);
  const m = parseInt(clean.slice(4, 6), 10) - 1;
  const d = parseInt(clean.slice(6, 8), 10);
  const h = parseInt(clean.slice(9, 11), 10);
  const min = parseInt(clean.slice(11, 13), 10);
  const s = parseInt(clean.slice(13, 15), 10);
  return Date.UTC(y, m, d, h, min, s);
}

function parseProperty(line: string): { name: string; value: string } {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return { name: line, value: '' };

  const nameWithParams = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const semiIdx = nameWithParams.indexOf(';');
  const name = semiIdx === -1 ? nameWithParams : nameWithParams.slice(0, semiIdx);

  return { name: name.toUpperCase(), value };
}

export function parseICalFeed(text: string): readonly ParsedICalEvent[] {
  const lines = unfoldLines(text);
  const events: ParsedICalEvent[] = [];

  let inEvent = false;
  let current: Record<string, string> = {};

  for (const line of lines) {
    const { name, value } = parseProperty(line);

    if (name === 'BEGIN' && value === 'VEVENT') {
      inEvent = true;
      current = {};
      continue;
    }

    if (name === 'END' && value === 'VEVENT') {
      inEvent = false;

      if (current.UID && current.DTSTART && current.SUMMARY) {
        const event: ParsedICalEvent = {
          uid: current.UID,
          summary: unescapeText(current.SUMMARY),
          start: parseICalDateTime(current.DTSTART),
          end: current.DTEND
            ? parseICalDateTime(current.DTEND)
            : parseICalDateTime(current.DTSTART),
          ...(current.DESCRIPTION ? { description: unescapeText(current.DESCRIPTION) } : {}),
          ...(current.LOCATION ? { location: unescapeText(current.LOCATION) } : {}),
          ...(current.CATEGORIES
            ? { category: unescapeText(current.CATEGORIES.split(',')[0]) }
            : {}),
          ...(current['LAST-MODIFIED']
            ? { lastModified: parseICalDateTime(current['LAST-MODIFIED']) }
            : {}),
        };
        events.push(event);
      }

      current = {};
      continue;
    }

    if (inEvent) {
      current[name] = value;
    }
  }

  return events;
}
