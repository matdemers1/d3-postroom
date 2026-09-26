// The calendar routes in the OpenAPI document (PST-REQ-085), generated from the same zod objects
// the routes validate with (schemas.ts). Spread into ROUTES/COMPONENTS by src/openapi/document.ts.
import type { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import * as C from './schemas.js';

export const CALENDAR_COMPONENTS: Record<string, z.ZodType> = {
  Calendar: C.Calendar,
  CalendarList: C.CalendarList,
  EventInstance: C.EventInstance,
  EventInstanceList: C.EventInstanceList,
  EventDetail: C.EventDetail,
  EventSaved: C.EventSaved,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];
const IF_MATCH = { name: 'if-match', required: true, description: 'The event’s ETag, as read.' };
const ETAG = { ETag: { description: 'The event’s entity tag, quoted.', schema: { type: 'string' } } };
const COMMON = { '400': err('The request failed validation.'), '401': err('No session.'), '404': err('No such calendar or event of the caller.'), '503': err('POSTROOM_KEK is not set.') };
const WRITE = { ...COMMON, '403': err('Missing CSRF header.'), '412': err('If-Match does not match: the event changed since it was read.'), '428': err('If-Match is missing.') };

export const CALENDAR_ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/calendar/calendars',
    operationId: 'listCalendars',
    tag: 'Calendar',
    summary: 'The caller’s calendars (the same collections CalDAV serves).',
    responses: { '200': { description: 'Calendars.', schema: 'CalendarList' }, '401': COMMON['401'], '503': COMMON['503'] },
  },
  {
    method: 'get',
    path: '/api/calendar/events',
    operationId: 'listEventInstances',
    tag: 'Calendar',
    summary: 'Every event instance overlapping a range, recurrences expanded.',
    description:
      'RRULE, RDATE, EXDATE and RECURRENCE-ID overrides are expanded (RFC 5545 §3.8.5); floating times and all-day days are read in `tz`. Sorted by start; at most 5000 instances (`truncated` says when more exist).',
    query: C.RangeQuery,
    responses: { '200': { description: 'Instances.', schema: 'EventInstanceList' }, '400': COMMON['400'], '401': COMMON['401'], '503': COMMON['503'] },
  },
  {
    method: 'post',
    path: '/api/calendar/calendars/{calendarId}/events',
    operationId: 'createEvent',
    tag: 'Calendar',
    summary: 'Create an event (optionally repeating) through the DAV store.',
    description: 'Encrypted, etagged, audited, and the calendar’s sync token advances: a CalDAV client’s next sync-collection reports it.',
    params: C.CalendarParams,
    body: C.EventRequest,
    headers: CSRF,
    responses: {
      '201': { description: 'Created.', schema: 'EventSaved', headers: ETAG },
      ...COMMON,
      '403': err('Missing CSRF header.'),
      '409': err('The calendar holds only tasks.'),
      '413': err('Larger than a calendar object may be.'),
      '507': err('The calendar is full.'),
    },
  },
  {
    method: 'get',
    path: '/api/calendar/calendars/{calendarId}/events/{name}',
    operationId: 'getEvent',
    tag: 'Calendar',
    summary: 'One event (its series master) as the form edits it.',
    params: C.EventParams,
    responses: { '200': { description: 'The event.', schema: 'EventDetail', headers: ETAG }, ...COMMON, '409': err('The stored object cannot be parsed.') },
  },
  {
    method: 'put',
    path: '/api/calendar/calendars/{calendarId}/events/{name}',
    operationId: 'updateEvent',
    tag: 'Calendar',
    summary: 'Edit the whole event or series. Properties the form does not own (alarms, attendees) are kept.',
    description: 'Moving the series’ start or changing its rule drops its overrides and exclusions. Omit `recurrence` to keep the rule as stored.',
    params: C.EventParams,
    body: C.EventRequest,
    headers: [...CSRF, IF_MATCH],
    responses: { '200': { description: 'Saved.', schema: 'EventSaved', headers: ETAG }, ...WRITE, '413': err('Larger than a calendar object may be.') },
  },
  {
    method: 'delete',
    path: '/api/calendar/calendars/{calendarId}/events/{name}',
    operationId: 'deleteEvent',
    tag: 'Calendar',
    summary: 'Delete the event (the whole series).',
    params: C.EventParams,
    headers: [...CSRF, IF_MATCH],
    responses: { '204': { description: 'Deleted.' }, ...WRITE },
  },
  {
    method: 'put',
    path: '/api/calendar/calendars/{calendarId}/events/{name}/instances/{recurrenceId}',
    operationId: 'updateEventInstance',
    tag: 'Calendar',
    summary: 'Edit one instance of a series: writes a RECURRENCE-ID override beside the master.',
    description: '"This and following" is not offered: an edit is to the whole series or one instance.',
    params: C.InstanceParams,
    body: C.InstanceRequest,
    headers: [...CSRF, IF_MATCH],
    responses: { '200': { description: 'Saved.', schema: 'EventSaved', headers: ETAG }, ...WRITE, '404': err('No such calendar, event or instance.'), '409': err('The event does not repeat.') },
  },
  {
    method: 'delete',
    path: '/api/calendar/calendars/{calendarId}/events/{name}/instances/{recurrenceId}',
    operationId: 'deleteEventInstance',
    tag: 'Calendar',
    summary: 'Delete one instance of a series: an EXDATE on the master.',
    params: C.InstanceParams,
    headers: [...CSRF, IF_MATCH],
    responses: { '200': { description: 'Saved.', schema: 'EventSaved', headers: ETAG }, ...WRITE, '404': err('No such calendar, event or instance.'), '409': err('The event does not repeat.') },
  },
];
