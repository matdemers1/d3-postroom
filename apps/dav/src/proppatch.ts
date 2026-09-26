// Setting collection properties: PROPPATCH (RFC 4918 §9.2), and the <set> of MKCALENDAR (RFC 4791
// §5.3.1) and extended MKCOL (RFC 5689). Atomic: every update is checked first, and if any fails
// none is applied — the failures carry their own status, everything else 424 Failed Dependency.
//
// Writable live properties: displayname, calendar-description / addressbook-description, Apple's
// calendar-color and calendar-order, and — at creation only — supported-calendar-component-set.
// Every other live property is protected (403 cannot-modify-protected-property). Anything the server
// does not know (calendar-timezone, schedule-calendar-transp, a client's own namespace) is kept as a
// dead property, bounded in number and size, and handed back verbatim.
import { NS, clark, childElements, attribute, el, serializeXml, textContent, type PropUpdate, type XmlElement } from '@postroom/dav-proto';
import { isLiveProperty, WRITABLE } from './props.js';
import type { CollectionFields, Kind } from './store.js';
import { CALENDAR_COMPONENTS } from './validate.js';

export const MAX_DEAD_PROPS = 32;
export const MAX_DEAD_PROP_BYTES = 16 * 1024;
const MAX_DISPLAYNAME = 256;
const MAX_DESCRIPTION = 4096;

export interface UpdateOutcome {
  readonly prop: XmlElement;
  readonly status: number;
  /** A precondition element (Clark name), for 403s. */
  readonly condition?: string;
}

export interface PatchResult {
  readonly ok: boolean;
  readonly fields: CollectionFields;
  readonly outcomes: UpdateOutcome[];
}

function bare(prop: XmlElement): XmlElement {
  return el(prop.ns, prop.local);
}

/** Apply updates to a copy of `base`. `creating` allows supported-calendar-component-set and resourcetype. */
export function applyUpdates(base: CollectionFields, updates: readonly PropUpdate[], kind: Kind, creating: boolean, defaultName: string): PatchResult {
  const fields: CollectionFields = { ...base, components: [...base.components], deadProps: { ...base.deadProps } };
  const outcomes: UpdateOutcome[] = [];
  const fail = (u: PropUpdate, status: number, condition?: string): void => {
    outcomes.push({ prop: bare(u.prop), status, ...(condition === undefined ? {} : { condition }) });
  };

  for (const u of updates) {
    const name = clark(u.prop.ns, u.prop.local);
    const text = textContent(u.prop).trim();
    const set = u.action === 'set';
    if (WRITABLE.has(name)) {
      const other = (name === clark(NS.CALDAV, 'calendar-description') && kind !== 'calendar') || (name === clark(NS.CARDDAV, 'addressbook-description') && kind !== 'addressbook');
      if (other) {
        fail(u, 403, clark(NS.DAV, 'cannot-modify-protected-property'));
        continue;
      }
      if (name === clark(NS.DAV, 'displayname')) {
        if (set && (text === '' || text.length > MAX_DISPLAYNAME)) {
          fail(u, 409);
          continue;
        }
        fields.displayName = set ? text : defaultName;
      } else if (name === clark(NS.ICAL, 'calendar-color')) {
        if (set && !/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(text)) {
          fail(u, 409);
          continue;
        }
        fields.color = set ? text : null;
      } else if (name === clark(NS.ICAL, 'calendar-order')) {
        if (set && (!/^-?[0-9]{1,10}$/.test(text) || Math.abs(Number(text)) > 2_147_483_647)) {
          fail(u, 409);
          continue;
        }
        fields.sortOrder = set ? Number(text) : null;
      } else {
        if (set && text.length > MAX_DESCRIPTION) {
          fail(u, 409);
          continue;
        }
        fields.description = set && text !== '' ? text : null;
      }
      outcomes.push({ prop: bare(u.prop), status: 200 });
      continue;
    }
    if (creating && set && name === clark(NS.CALDAV, 'supported-calendar-component-set') && kind === 'calendar') {
      const comps = childElements(u.prop, NS.CALDAV, 'comp').map((c) => (attribute(c, 'name') ?? '').toUpperCase());
      if (comps.length === 0 || comps.some((c) => !(CALENDAR_COMPONENTS as readonly string[]).includes(c))) {
        fail(u, 403, clark(NS.CALDAV, 'supported-calendar-component'));
        continue;
      }
      fields.components = [...new Set(comps)];
      outcomes.push({ prop: bare(u.prop), status: 200 });
      continue;
    }
    if (creating && set && name === clark(NS.DAV, 'resourcetype')) {
      // Checked by the MKCOL handler against the home it is created in.
      outcomes.push({ prop: bare(u.prop), status: 200 });
      continue;
    }
    if (isLiveProperty(name) || name === clark(NS.CALDAV, 'supported-calendar-component-set') || name === clark(NS.DAV, 'resourcetype')) {
      fail(u, 403, clark(NS.DAV, 'cannot-modify-protected-property'));
      continue;
    }
    // A dead property.
    if (set) {
      const stored: XmlElement = { ns: u.prop.ns, local: u.prop.local, attrs: [], children: u.prop.children };
      const size = Buffer.byteLength(serializeXml(stored, { declaration: false }), 'utf8');
      const count = Object.keys(fields.deadProps).length + (name in fields.deadProps ? 0 : 1);
      if (size > MAX_DEAD_PROP_BYTES || count > MAX_DEAD_PROPS) {
        fail(u, 507);
        continue;
      }
      fields.deadProps[name] = stored;
    } else {
      // Removing a property that does not exist is not an error (RFC 4918 §14.23).
      fields.deadProps = Object.fromEntries(Object.entries(fields.deadProps).filter(([k]) => k !== name));
    }
    outcomes.push({ prop: bare(u.prop), status: 200 });
  }

  if (outcomes.every((o) => o.status === 200)) return { ok: true, fields, outcomes };
  return { ok: false, fields: base, outcomes: outcomes.map((o) => (o.status === 200 ? { prop: o.prop, status: 424 } : o)) };
}

/** MKCOL's resourcetype must be a calendar or address book collection matching the home. */
export function resourcetypeKind(props: readonly XmlElement[]): Kind | 'plain' | null {
  const rt = props.find((p) => p.ns === NS.DAV && p.local === 'resourcetype');
  if (rt === undefined) return null;
  const kids = childElements(rt);
  const isCollection = kids.some((k) => k.ns === NS.DAV && k.local === 'collection');
  if (!isCollection) return 'plain';
  const cal = kids.some((k) => k.ns === NS.CALDAV && k.local === 'calendar');
  const card = kids.some((k) => k.ns === NS.CARDDAV && k.local === 'addressbook');
  if (cal === card) return 'plain';
  return cal ? 'calendar' : 'addressbook';
}
