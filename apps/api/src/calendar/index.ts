// The calendar API (PST-T-8.5, PST-REQ-136). Mounted by app.ts at /api/calendar behind a session,
// the CSRF guard and the audit guard, like the mail routes.
//
// Every write goes through @postroom/dav-store's DavStore — the one the DAV daemon uses — so an
// event made or edited here is encrypted, gets a fresh etag, advances the calendar's sync token and
// writes its audit row in one transaction, and an iPhone's next sync-collection pulls it
// (PST-REQ-137's "edits sync"). Writes to an existing event need If-Match with its etag: a phone may
// have changed it since the page read it, and a stale form must not overwrite that.
//
// Reading a range expands every event with @postroom/ical's expandCalendar — RRULE, RDATE, EXDATE
// and RECURRENCE-ID overrides — in the viewer's zone for floating times and all-day days. Parsed
// calendar objects are cached by etag, so an unchanged calendar costs one metadata query.
import { randomUUID } from 'node:crypto';
import { getAuditContext } from '@postroom/audit';
import type { Caller, Collection, DavStore, PutOutcome } from '@postroom/dav-store';
import { expandCalendar, getProperty, parseICalendar, serializeICalendar, type Component } from '@postroom/ical';
import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import { currentSession, handle } from '../auth/middleware.js';
import type { ApiDeps } from '../deps.js';
import { davFor, formatEtag, ifMatchOf, ownCollection } from '../contacts/dav.js';
import {
  applyEventInput,
  applyInstanceOverride,
  buildEvent,
  EventError,
  eventView,
  excludeInstance,
  instanceView,
  isRecurring,
  knownZone,
  masterOf,
} from './event.js';
import {
  CalendarParams,
  EventParams,
  EventRequest,
  InstanceParams,
  InstanceRequest,
  RangeQuery,
  type CalendarJson,
  type EventDetailJson,
  type EventInstanceJson,
  type EventSavedJson,
} from './schemas.js';

const MAX_RANGE_MS = 400 * 86_400_000;
const MAX_INSTANCES = 5000;
const CACHE_ENTRIES = 20_000;

function parse<S extends z.ZodType>(schema: S, value: unknown, res: Response): z.output<S> | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  res.status(400).json({ error: 'invalid_request', message: result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ') });
  return null;
}

const holdsEvents = (c: Collection): boolean => c.components.length === 0 || c.components.includes('VEVENT');

function calendarJson(c: Collection): CalendarJson {
  return { id: c.id, displayName: c.displayName, color: c.color, components: c.components, canHoldEvents: holdsEvents(c) };
}

/** Parsed calendar objects by collection + name, valid while the etag matches. Least recently used goes. */
class ParsedCache {
  private readonly map = new Map<string, { etag: string; calendar: Component | null }>();
  get(key: string, etag: string): Component | null | undefined {
    const hit = this.map.get(key);
    if (hit === undefined || hit.etag !== etag) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.calendar;
  }
  set(key: string, etag: string, calendar: Component | null): void {
    this.map.delete(key);
    this.map.set(key, { etag, calendar });
    while (this.map.size > CACHE_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

function tryParse(data: Buffer): Component | null {
  try {
    return parseICalendar(data);
  } catch {
    return null; // Stored by a client, refused by nobody here: an unparseable object shows nothing.
  }
}

function eventErrorStatus(e: EventError): number {
  switch (e.code) {
    case 'invalid_event':
      return 400;
    case 'no_such_instance':
      return 404;
    default:
      return 409;
  }
}

function putStatus(res: Response, outcome: PutOutcome): boolean {
  switch (outcome.status) {
    case 'created':
    case 'updated':
      return true;
    case 'precondition-failed':
      res.status(412).json({ error: 'precondition_failed', message: 'The event changed since it was read; reload it.' });
      return false;
    case 'uid-conflict':
      res.status(409).json({ error: 'uid_conflict', message: 'Another event in this calendar has that UID.' });
      return false;
    case 'collection-gone':
      res.status(404).json({ error: 'not_found' });
      return false;
    case 'collection-full':
      res.status(507).json({ error: 'calendar_full', message: 'This calendar holds as many events as it may.' });
      return false;
  }
}

export function calendarRoutes(deps: ApiDeps): Router {
  const router = Router();
  const cache = new ParsedCache();

  const callerOf = (req: Request): Caller => ({ accountId: currentSession(req).accountId, context: getAuditContext(req) });

  /** The event resource (decrypted and parsed), or null having answered. */
  const loadEvent = async (store: DavStore, collection: Collection, name: string, res: Response): Promise<{ calendar: Component; etag: string } | null> => {
    const resource = (await store.getResources(collection.id, [name]))[0];
    if (resource === undefined || resource.componentType !== 'VEVENT') {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    const calendar = tryParse(resource.data);
    if (calendar === null) {
      res.status(409).json({ error: 'unreadable', message: 'This calendar object cannot be parsed.' });
      return null;
    }
    return { calendar, etag: resource.etag };
  };

  const write = async (
    store: DavStore,
    caller: Caller,
    collection: Collection,
    input: { name: string; uid: string; calendar: Component; ifMatch: string | null; create: boolean },
    maxBytes: number,
    res: Response,
  ): Promise<string | null> => {
    const data = Buffer.from(serializeICalendar(input.calendar), 'utf8');
    if (data.length > maxBytes) {
      res.status(413).json({ error: 'too_large', message: 'The event is larger than a calendar object may be.' });
      return null;
    }
    const outcome = await store.putResource(caller, collection, {
      name: input.name,
      uid: input.uid,
      componentType: 'VEVENT',
      data,
      preconditions: input.create ? { ifNoneMatch: '*' } : { ifMatch: input.ifMatch ?? undefined },
    });
    if (!putStatus(res, outcome) || (outcome.status !== 'created' && outcome.status !== 'updated')) return null;
    cache.set(`${collection.id}/${input.name}`, outcome.etag, input.calendar);
    return outcome.etag;
  };

  /** The collection named by :calendarId, or null having answered 404. */
  const calendarOf = async (store: DavStore, req: Request, id: string, res: Response): Promise<Collection | null> => {
    const c = await ownCollection(store, currentSession(req).accountId, 'calendar', id);
    if (c === null) res.status(404).json({ error: 'not_found' });
    return c;
  };

  const requireIfMatch = (req: Request, res: Response): string | null => {
    const ifMatch = ifMatchOf(req.get('if-match'));
    if (ifMatch === null) res.status(428).json({ error: 'precondition_required', message: 'Send If-Match with the event’s ETag.' });
    return ifMatch;
  };

  const answerEventError = (res: Response, error: unknown): boolean => {
    if (!(error instanceof EventError)) return false;
    res.status(eventErrorStatus(error)).json({ error: error.code, message: error.message });
    return true;
  };

  router.get(
    '/calendars',
    handle(async (req, res) => {
      const dav = davFor(deps, res);
      if (dav === null) return;
      const list = await dav.store.listCollections(currentSession(req).accountId, 'calendar');
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ calendars: list.map(calendarJson) });
    }),
  );

  router.get(
    '/events',
    handle(async (req, res) => {
      const query = parse(RangeQuery, req.query, res);
      if (query === null) return;
      const dav = davFor(deps, res);
      if (dav === null) return;
      const start = Date.parse(query.start);
      const end = Date.parse(query.end);
      if (!(end > start) || end - start > MAX_RANGE_MS) {
        res.status(400).json({ error: 'invalid_request', message: 'end must be after start, and at most 400 days after it' });
        return;
      }
      if (!knownZone(query.tz)) {
        res.status(400).json({ error: 'invalid_request', message: 'tz is not a known time zone' });
        return;
      }
      const accountId = currentSession(req).accountId;
      const calendars = (await dav.store.listCollections(accountId, 'calendar')).filter((c) => holdsEvents(c) && (query.calendarId === undefined || c.id === query.calendarId));
      const instances: EventInstanceJson[] = [];
      let truncated = false;
      for (const c of calendars) {
        const metas = (await dav.store.listResources(c.id)).filter((m) => m.componentType === 'VEVENT');
        const stale = metas.filter((m) => cache.get(`${c.id}/${m.name}`, m.etag) === undefined).map((m) => m.name);
        if (stale.length > 0) {
          for (const r of await dav.store.getResources(c.id, stale)) cache.set(`${c.id}/${r.name}`, r.etag, tryParse(r.data));
        }
        for (const m of metas) {
          const calendar = cache.get(`${c.id}/${m.name}`, m.etag);
          if (calendar === undefined || calendar === null) continue;
          const expanded = expandCalendar(calendar, { start, end, floatingTzid: query.tz, maxInstances: MAX_INSTANCES });
          truncated ||= expanded.truncated;
          const recurring = isRecurring(calendar);
          for (const i of expanded.instances) {
            if (i.component.name !== 'VEVENT') continue;
            instances.push({ calendarId: c.id, name: m.name, etag: m.etag, ...instanceView(i, recurring, query.tz) });
          }
        }
      }
      instances.sort((a, b) => a.start.localeCompare(b.start) || a.summary.localeCompare(b.summary));
      if (instances.length > MAX_INSTANCES) {
        instances.length = MAX_INSTANCES;
        truncated = true;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ instances, truncated });
    }),
  );

  router.post(
    '/calendars/:calendarId/events',
    handle(async (req, res) => {
      const params = parse(CalendarParams, req.params, res);
      if (params === null) return;
      const body = parse(EventRequest, req.body, res);
      if (body === null) return;
      const dav = davFor(deps, res);
      if (dav === null) return;
      const collection = await calendarOf(dav.store, req, params.calendarId, res);
      if (collection === null) return;
      if (!holdsEvents(collection)) {
        res.status(409).json({ error: 'not_an_event_calendar', message: 'This calendar holds only tasks.' });
        return;
      }
      const uid = randomUUID().toUpperCase();
      const name = `${uid}.ics`;
      let calendar: Component;
      try {
        calendar = buildEvent(uid, body, new Date());
      } catch (error) {
        if (answerEventError(res, error)) return;
        throw error;
      }
      const etag = await write(dav.store, callerOf(req), collection, { name, uid, calendar, ifMatch: null, create: true }, dav.maxResourceBytes, res);
      if (etag === null) return;
      const json: EventSavedJson = { calendarId: collection.id, name, uid, etag };
      res.setHeader('ETag', formatEtag(etag));
      res.status(201).json(json);
    }),
  );

  router.get(
    '/calendars/:calendarId/events/:name',
    handle(async (req, res) => {
      const params = parse(EventParams, req.params, res);
      if (params === null) return;
      const dav = davFor(deps, res);
      if (dav === null) return;
      const collection = await calendarOf(dav.store, req, params.calendarId, res);
      if (collection === null) return;
      const found = await loadEvent(dav.store, collection, params.name, res);
      if (found === null) return;
      let view;
      try {
        view = eventView(found.calendar);
      } catch (error) {
        if (answerEventError(res, error)) return;
        throw error;
      }
      const json: EventDetailJson = { calendarId: collection.id, name: params.name, etag: found.etag, ...view };
      res.setHeader('ETag', formatEtag(found.etag));
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(json);
    }),
  );

  /** PUT/DELETE on an existing event: load, check If-Match, transform, write back. */
  const edit = (
    schemaParams: typeof EventParams | typeof InstanceParams,
    transform: (calendar: Component, req: Request, params: Record<string, string>) => Component | null,
    answer: (res: Response, saved: EventSavedJson) => void,
  ) =>
    handle(async (req, res) => {
      const params = parse(schemaParams, req.params, res) as Record<string, string> | null;
      if (params === null) return;
      const ifMatch = requireIfMatch(req, res);
      if (ifMatch === null) return;
      const dav = davFor(deps, res);
      if (dav === null) return;
      const collection = await calendarOf(dav.store, req, params['calendarId'] ?? '', res);
      if (collection === null) return;
      const name = params['name'] ?? '';
      const found = await loadEvent(dav.store, collection, name, res);
      if (found === null) return;
      let next: Component | null;
      try {
        next = transform(found.calendar, req, params);
      } catch (error) {
        if (answerEventError(res, error)) return;
        throw error;
      }
      if (next === null) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const uid = getProperty(masterOf(found.calendar), 'UID')?.value ?? '';
      const etag = await write(dav.store, callerOf(req), collection, { name, uid, calendar: next, ifMatch, create: false }, dav.maxResourceBytes, res);
      if (etag === null) return;
      res.setHeader('ETag', formatEtag(etag));
      answer(res, { calendarId: collection.id, name, uid, etag });
    });

  const bodyOr400 = <S extends z.ZodType>(schema: S, req: Request): z.output<S> | null => {
    const r = schema.safeParse(req.body);
    if (!r.success) throw new EventError('invalid_event', r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '));
    return r.data;
  };

  router.put(
    '/calendars/:calendarId/events/:name',
    edit(
      EventParams,
      (calendar, req) => {
        const body = bodyOr400(EventRequest, req);
        return body === null ? null : applyEventInput(calendar, body, new Date());
      },
      (res, saved) => res.json(saved),
    ),
  );

  router.put(
    '/calendars/:calendarId/events/:name/instances/:recurrenceId',
    edit(
      InstanceParams,
      (calendar, req, params) => {
        const body = bodyOr400(InstanceRequest, req);
        return body === null ? null : applyInstanceOverride(calendar, params['recurrenceId'] ?? '', { ...body, recurrence: null }, new Date());
      },
      (res, saved) => res.json(saved),
    ),
  );

  router.delete(
    '/calendars/:calendarId/events/:name/instances/:recurrenceId',
    edit(
      InstanceParams,
      (calendar, _req, params) => excludeInstance(calendar, params['recurrenceId'] ?? ''),
      (res, saved) => res.json(saved),
    ),
  );

  router.delete(
    '/calendars/:calendarId/events/:name',
    handle(async (req, res) => {
      const params = parse(EventParams, req.params, res);
      if (params === null) return;
      const ifMatch = requireIfMatch(req, res);
      if (ifMatch === null) return;
      const dav = davFor(deps, res);
      if (dav === null) return;
      const collection = await calendarOf(dav.store, req, params.calendarId, res);
      if (collection === null) return;
      const outcome = await dav.store.deleteResource(callerOf(req), collection, params.name, { ifMatch });
      if (outcome === 'not-found') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (outcome === 'precondition-failed') {
        res.status(412).json({ error: 'precondition_failed', message: 'The event changed since it was read; reload it.' });
        return;
      }
      res.status(204).end();
    }),
  );

  return router;
}
