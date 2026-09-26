// The zod schemas of the calendar API (PST-T-8.5, PST-REQ-136). They validate every request, and
// the OpenAPI document is generated from these same objects (PST-REQ-085).
import { z } from 'zod';

const Uuid = z.uuid();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const DayOrLocal = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, 'YYYY-MM-DD or YYYY-MM-DDTHH:mm');
const Zone = z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/, 'an IANA time zone, e.g. America/New_York');
/** A resource name as the store holds it: one path segment. */
const ResourceName = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => s !== '.' && s !== '..' && !s.includes('/'), 'a resource name');
const Weekday = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

export const Recurrence = z.object({
  freq: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  interval: z.number().int().min(1).max(999).default(1),
  byDay: z.array(Weekday).max(7).default([]).describe('WEEKLY only: the weekdays it falls on (empty: the start’s weekday).'),
  count: z.number().int().min(1).max(5000).nullable().default(null),
  until: Day.nullable().default(null).describe('The last day of the series (inclusive), in the event’s zone.'),
});

export const EventRequest = z.object({
  summary: z.string().max(1000).default(''),
  description: z.string().max(100_000).default(''),
  location: z.string().max(1000).default(''),
  allDay: z.boolean().default(false),
  start: DayOrLocal.describe('YYYY-MM-DD when all-day, else the local YYYY-MM-DDTHH:mm in `timezone`.'),
  end: DayOrLocal.describe('Exclusive: the day after the last when all-day; else the local YYYY-MM-DDTHH:mm.'),
  timezone: Zone.default('UTC'),
  recurrence: Recurrence.nullable().optional().describe('null: does not repeat. Omitted on an update: keep the series’ rule.'),
});

export const InstanceRequest = EventRequest.omit({ recurrence: true });

export const RangeQuery = z.object({
  start: z.iso.datetime({ offset: true }).describe('Range start (inclusive), an ISO instant.'),
  end: z.iso.datetime({ offset: true }).describe('Range end (exclusive); at most 400 days after start.'),
  tz: Zone.default('UTC').describe('The viewer’s zone: floating times and all-day days are read in it.'),
  calendarId: Uuid.optional(),
});

export const CalendarParams = z.object({ calendarId: Uuid });
export const EventParams = z.object({ calendarId: Uuid, name: ResourceName });
export const InstanceParams = z.object({
  calendarId: Uuid,
  name: ResourceName,
  recurrenceId: z.string().regex(/^\d{8}(T\d{6}Z?)?$/, 'a RECURRENCE-ID: YYYYMMDD, YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ'),
});

// Responses

export const Calendar = z.object({
  id: Uuid,
  displayName: z.string(),
  color: z.string().nullable().describe('Apple’s calendar-color, e.g. #FF2968FF.'),
  components: z.array(z.string()),
  canHoldEvents: z.boolean(),
});
export const CalendarList = z.object({ calendars: z.array(Calendar) });

export const EventInstance = z.object({
  calendarId: Uuid,
  name: z.string().describe('The event’s resource name in its calendar.'),
  etag: z.string(),
  uid: z.string(),
  recurrenceId: z.string(),
  start: z.string().describe('UTC ISO instant.'),
  end: z.string(),
  allDay: z.boolean(),
  startDay: z.string().nullable().describe('All-day only: the first day.'),
  endDay: z.string().nullable().describe('All-day only: the day after the last.'),
  summary: z.string(),
  location: z.string(),
  recurring: z.boolean(),
  override: z.boolean(),
});
export const EventInstanceList = z.object({ instances: z.array(EventInstance), truncated: z.boolean() });

export const RecurrenceDetail = z.object({
  freq: z.string(),
  interval: z.number(),
  byDay: z.array(z.string()),
  count: z.number().nullable(),
  until: z.string().nullable(),
  rule: z.string().describe('The RRULE as stored.'),
  editable: z.boolean().describe('False when the rule uses parts the web form cannot show.'),
});

export const EventDetail = z.object({
  calendarId: Uuid,
  name: z.string(),
  etag: z.string(),
  uid: z.string(),
  summary: z.string(),
  description: z.string(),
  location: z.string(),
  allDay: z.boolean(),
  start: z.string(),
  end: z.string(),
  timezone: z.string().nullable(),
  recurrence: RecurrenceDetail.nullable(),
  overrides: z.array(z.string()),
  exdates: z.array(z.string()),
});

export const EventSaved = z.object({ calendarId: Uuid, name: z.string(), uid: z.string(), etag: z.string() });

export type CalendarJson = z.infer<typeof Calendar>;
export type EventInstanceJson = z.infer<typeof EventInstance>;
export type EventDetailJson = z.infer<typeof EventDetail>;
export type EventSavedJson = z.infer<typeof EventSaved>;
