/**
 * Minimal RFC 5545 (iCalendar) serializer.
 *
 * Converts calendar event records into VCALENDAR/VEVENT text format.
 * No external dependencies — just string formatting.
 */

export interface ICalEvent {
  readonly id: string;
  readonly start: number | string;
  readonly end: number | string;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly category?: string;
  readonly sourceCalendar?: string;
  readonly lastModified?: number | string;
}

export interface ICalFeedOptions {
  readonly name: string;
  readonly prodId?: string;
  readonly domain?: string;
}

function formatDateTime(value: number | string): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}T${h}${min}${s}Z`;
}

function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  let pos = 75;
  while (pos < line.length) {
    parts.push(` ${line.slice(pos, pos + 74)}`);
    pos += 74;
  }
  return parts.join('\r\n');
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function serializeEvent(event: ICalEvent, domain: string): string {
  const lines: string[] = [
    'BEGIN:VEVENT',
    foldLine(`UID:${event.id}@${domain}`),
    `DTSTART:${formatDateTime(event.start)}`,
    `DTEND:${formatDateTime(event.end)}`,
    foldLine(`SUMMARY:${escapeText(event.title)}`),
  ];

  if (event.description) lines.push(foldLine(`DESCRIPTION:${escapeText(event.description)}`));
  if (event.location) lines.push(foldLine(`LOCATION:${escapeText(event.location)}`));
  if (event.category) lines.push(`CATEGORIES:${escapeText(event.category)}`);
  if (event.sourceCalendar) lines.push(foldLine(`X-JANUS-CALENDAR:${escapeText(event.sourceCalendar)}`));
  if (event.lastModified) lines.push(`LAST-MODIFIED:${formatDateTime(event.lastModified)}`);

  lines.push(`DTSTAMP:${formatDateTime(Date.now())}`);
  lines.push('END:VEVENT');

  return lines.join('\r\n');
}

export function serializeICalFeed(events: readonly ICalEvent[], options: ICalFeedOptions): string {
  const prodId = options.prodId ?? '-//Janus//Calendar//EN';
  const domain = options.domain ?? 'janus';

  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    foldLine(`PRODID:${prodId}`),
    foldLine(`X-WR-CALNAME:${escapeText(options.name)}`),
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ].join('\r\n');

  const body = events.map((e) => serializeEvent(e, domain)).join('\r\n');
  const footer = 'END:VCALENDAR';

  return body.length > 0 ? `${header}\r\n${body}\r\n${footer}\r\n` : `${header}\r\n${footer}\r\n`;
}

export const ICAL_CONTENT_TYPE = 'text/calendar; charset=utf-8';
