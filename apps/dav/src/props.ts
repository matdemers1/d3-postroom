// Properties: which ones each kind of resource has, what they hold, and a PROPFIND/REPORT answer for
// a prop / allprop / propname request. Unknown properties come back under 404, as RFC 4918 wants.
//
// The set is what iOS, macOS and DAVx5 ask for during discovery and sync: current-user-principal,
// principal-URL, calendar-home-set, addressbook-home-set, calendar-user-address-set, resourcetype,
// displayname, supported-calendar-component-set, supported-report-set, sync-token, getctag
// (CalendarServer), calendar-color / calendar-order (Apple), getetag, current-user-privilege-set.
import { NS, clark, el, groupPropstats, type PropRequest, type PropStat, type XmlElement, type XmlNode } from '@postroom/dav-proto';
import { homeHref, principalHref } from './paths.js';
import type { Collection, Kind, ResourceMeta } from './store.js';

export type Node =
  | { readonly type: 'root' }
  | { readonly type: 'principal' }
  | { readonly type: 'home'; readonly kind: Kind }
  | { readonly type: 'collection'; readonly collection: Collection }
  | { readonly type: 'object'; readonly collection: Collection; readonly meta: ResourceMeta; readonly data: () => Promise<Buffer> };

export interface PropEnv {
  readonly accountId: string;
  readonly maxResourceBytes: number;
  /** Memoised by the caller: the account's display name and addresses. */
  readonly principal: () => Promise<{ displayName: string; addresses: string[] }>;
}

/** The sync token of a collection at `seq` (RFC 6578 requires a URI). */
export function syncToken(collectionId: string, seq: bigint): string {
  return `http://postroom.d3cloud.io/ns/sync/${collectionId}/${seq.toString()}`;
}

/** The inverse of {@link syncToken}; null when it is not one of ours. */
export function parseSyncToken(token: string): { collectionId: string; seq: bigint } | null {
  const m = /^http:\/\/postroom\.d3cloud\.io\/ns\/sync\/([0-9a-f-]{36})\/(0|[1-9][0-9]{0,18})$/.exec(token);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  return { collectionId: m[1], seq: BigInt(m[2]) };
}

const d = (local: string, children: XmlNode[] = []): XmlElement => el(NS.DAV, local, children);
const href = (h: string): XmlElement => d('href', [h]);

function privileges(node: Node): XmlElement[] {
  const names =
    node.type === 'collection' || node.type === 'object'
      ? ['all', 'read', 'write', 'write-properties', 'write-content', 'bind', 'unbind', 'read-current-user-privilege-set']
      : node.type === 'home'
        ? ['read', 'bind', 'unbind', 'read-current-user-privilege-set']
        : ['read', 'read-current-user-privilege-set'];
  return names.map((n) => d('privilege', [d(n)]));
}

function kindOf(node: Node): Kind | null {
  if (node.type === 'home') return node.kind;
  if (node.type === 'collection' || node.type === 'object') return node.collection.kind;
  return null;
}

function reports(kind: Kind): XmlElement[] {
  const names: [string, string][] =
    kind === 'calendar'
      ? [
          [NS.CALDAV, 'calendar-query'],
          [NS.CALDAV, 'calendar-multiget'],
          [NS.DAV, 'sync-collection'],
        ]
      : [
          [NS.CARDDAV, 'addressbook-query'],
          [NS.CARDDAV, 'addressbook-multiget'],
          [NS.DAV, 'sync-collection'],
        ];
  return names.map(([ns, local]) => d('supported-report', [d('report', [el(ns, local)])]));
}

type Value = XmlNode[] | null;
interface LiveProp {
  /** Included in allprop (RFC 4918 §9.1: the DAV: live properties; never calendar-data). */
  readonly allprop?: boolean;
  /** PROPPATCH may not touch it. */
  readonly value: (node: Node, env: PropEnv) => Value | Promise<Value>;
}

const LIVE: ReadonlyMap<string, LiveProp> = new Map<string, LiveProp>([
  [
    clark(NS.DAV, 'resourcetype'),
    {
      allprop: true,
      value: (n) => {
        switch (n.type) {
          case 'root':
          case 'home':
            return [d('collection')];
          case 'principal':
            return [d('collection'), d('principal')];
          case 'collection':
            return [d('collection'), n.collection.kind === 'calendar' ? el(NS.CALDAV, 'calendar') : el(NS.CARDDAV, 'addressbook')];
          case 'object':
            return [];
        }
      },
    },
  ],
  [
    clark(NS.DAV, 'displayname'),
    {
      allprop: true,
      value: async (n, env) => {
        if (n.type === 'principal') return [(await env.principal()).displayName];
        if (n.type === 'collection') return [n.collection.displayName];
        if (n.type === 'home') return [n.kind === 'calendar' ? 'Calendars' : 'Address Books'];
        return null;
      },
    },
  ],
  [clark(NS.DAV, 'current-user-principal'), { value: (_n, env) => [href(principalHref(env.accountId))] }],
  [clark(NS.DAV, 'principal-URL'), { value: (n, env) => (n.type === 'principal' ? [href(principalHref(env.accountId))] : null) }],
  [clark(NS.DAV, 'owner'), { value: (n, env) => (n.type === 'root' ? null : [href(principalHref(env.accountId))]) }],
  [clark(NS.DAV, 'current-user-privilege-set'), { value: (n) => privileges(n) }],
  [
    clark(NS.DAV, 'supported-report-set'),
    {
      value: (n) => {
        const k = kindOf(n);
        return k === null || n.type === 'home' ? null : reports(k);
      },
    },
  ],
  [clark(NS.DAV, 'sync-token'), { value: (n) => (n.type === 'collection' ? [syncToken(n.collection.id, n.collection.syncSeq)] : null) }],
  [clark(NS.CS, 'getctag'), { value: (n) => (n.type === 'collection' ? [syncToken(n.collection.id, n.collection.syncSeq)] : null) }],
  [clark(NS.DAV, 'getetag'), { allprop: true, value: (n) => (n.type === 'object' ? [`"${n.meta.etag}"`] : null) }],
  [
    clark(NS.DAV, 'getcontenttype'),
    {
      allprop: true,
      value: (n) => {
        if (n.type !== 'object') return null;
        return [n.collection.kind === 'calendar' ? `text/calendar; charset=utf-8; component=${(n.meta.componentType ?? 'VEVENT').toLowerCase()}` : 'text/vcard; charset=utf-8'];
      },
    },
  ],
  [clark(NS.DAV, 'getcontentlength'), { allprop: true, value: (n) => (n.type === 'object' ? [String(n.meta.size)] : null) }],
  [
    clark(NS.DAV, 'getlastmodified'),
    {
      allprop: true,
      value: (n) => (n.type === 'object' ? [n.meta.updatedAt.toUTCString()] : n.type === 'collection' ? [n.collection.updatedAt.toUTCString()] : null),
    },
  ],
  [
    clark(NS.CALDAV, 'calendar-home-set'),
    { value: (n, env) => (n.type === 'principal' || n.type === 'root' ? [href(homeHref(env.accountId, 'calendar'))] : null) },
  ],
  [
    clark(NS.CARDDAV, 'addressbook-home-set'),
    { value: (n, env) => (n.type === 'principal' || n.type === 'root' ? [href(homeHref(env.accountId, 'addressbook'))] : null) },
  ],
  [
    clark(NS.CALDAV, 'calendar-user-address-set'),
    {
      value: async (n, env) => {
        if (n.type !== 'principal') return null;
        const { addresses } = await env.principal();
        return [...addresses.map((a) => href(`mailto:${a}`)), href(principalHref(env.accountId))];
      },
    },
  ],
  [
    clark(NS.CALDAV, 'supported-calendar-component-set'),
    {
      value: (n) =>
        n.type === 'collection' && n.collection.kind === 'calendar'
          ? n.collection.components.map((c) => el(NS.CALDAV, 'comp', [], [{ ns: '', local: 'name', value: c }]))
          : null,
    },
  ],
  [
    clark(NS.CALDAV, 'supported-calendar-data'),
    {
      value: (n) =>
        kindOf(n) === 'calendar' && n.type !== 'home'
          ? [el(NS.CALDAV, 'calendar-data', [], [{ ns: '', local: 'content-type', value: 'text/calendar' }, { ns: '', local: 'version', value: '2.0' }])]
          : null,
    },
  ],
  [
    clark(NS.CARDDAV, 'supported-address-data'),
    {
      value: (n) =>
        kindOf(n) === 'addressbook' && n.type !== 'home'
          ? ['3.0', '4.0'].map((v) => el(NS.CARDDAV, 'address-data-type', [], [{ ns: '', local: 'content-type', value: 'text/vcard' }, { ns: '', local: 'version', value: v }]))
          : null,
    },
  ],
  [clark(NS.CALDAV, 'max-resource-size'), { value: (n, env) => (n.type === 'collection' && n.collection.kind === 'calendar' ? [String(env.maxResourceBytes)] : null) }],
  [clark(NS.CARDDAV, 'max-resource-size'), { value: (n, env) => (n.type === 'collection' && n.collection.kind === 'addressbook' ? [String(env.maxResourceBytes)] : null) }],
  [
    clark(NS.CALDAV, 'calendar-description'),
    { value: (n) => (n.type === 'collection' && n.collection.kind === 'calendar' && n.collection.description !== null ? [n.collection.description] : null) },
  ],
  [
    clark(NS.CARDDAV, 'addressbook-description'),
    { value: (n) => (n.type === 'collection' && n.collection.kind === 'addressbook' && n.collection.description !== null ? [n.collection.description] : null) },
  ],
  [clark(NS.ICAL, 'calendar-color'), { value: (n) => (n.type === 'collection' && n.collection.color !== null ? [n.collection.color] : null) }],
  [clark(NS.ICAL, 'calendar-order'), { value: (n) => (n.type === 'collection' && n.collection.sortOrder !== null ? [String(n.collection.sortOrder)] : null) }],
  [
    clark(NS.CALDAV, 'calendar-data'),
    { value: async (n) => (n.type === 'object' && n.collection.kind === 'calendar' ? [(await n.data()).toString('utf8')] : null) },
  ],
  [
    clark(NS.CARDDAV, 'address-data'),
    { value: async (n) => (n.type === 'object' && n.collection.kind === 'addressbook' ? [(await n.data()).toString('utf8')] : null) },
  ],
]);

/** Properties the server computes. A PROPPATCH may set only the few in {@link WRITABLE}. */
export function isLiveProperty(name: string): boolean {
  return LIVE.has(name);
}

/** Live properties a PROPPATCH (or MKCALENDAR/MKCOL) may set on a collection. */
export const WRITABLE = new Set([
  clark(NS.DAV, 'displayname'),
  clark(NS.CALDAV, 'calendar-description'),
  clark(NS.CARDDAV, 'addressbook-description'),
  clark(NS.ICAL, 'calendar-color'),
  clark(NS.ICAL, 'calendar-order'),
]);

/** Found properties first, then the rest: the order every client log reader expects. */
function ordered(results: { status: number; prop: XmlElement }[]): PropStat[] {
  return groupPropstats(results).sort((a, b) => Number(b.status === 200) - Number(a.status === 200));
}

async function valueOf(node: Node, name: string, env: PropEnv): Promise<Value> {
  const live = LIVE.get(name);
  if (live !== undefined) return live.value(node, env);
  if (node.type === 'collection') {
    const dead = node.collection.deadProps[name];
    if (dead !== undefined) return dead.children;
  }
  return null;
}

function elementFor(name: string, children: XmlNode[] = [], template?: XmlElement): XmlElement {
  if (template !== undefined) return { ns: template.ns, local: template.local, attrs: [], children };
  const close = name.indexOf('}');
  return el(name.slice(1, close), name.slice(close + 1), children);
}

function allNames(node: Node, onlyAllprop: boolean): string[] {
  const out: string[] = [];
  for (const [name, p] of LIVE) if (!onlyAllprop || p.allprop === true) out.push(name);
  if (node.type === 'collection') out.push(...Object.keys(node.collection.deadProps));
  return out;
}

/** Answer a prop / allprop / propname request for one resource. */
export async function propstatsFor(node: Node, request: PropRequest, env: PropEnv): Promise<PropStat[]> {
  const results: { status: number; prop: XmlElement }[] = [];
  if (request.kind === 'propname') {
    for (const name of allNames(node, false)) {
      if ((await valueOf(node, name, env)) !== null) results.push({ status: 200, prop: elementFor(name) });
    }
    return ordered(results);
  }
  if (request.kind === 'allprop') {
    const names = new Set(allNames(node, true));
    for (const inc of request.include) names.add(clark(inc.ns, inc.local));
    for (const name of names) {
      const v = await valueOf(node, name, env);
      if (v !== null) results.push({ status: 200, prop: elementFor(name, v) });
    }
    return ordered(results);
  }
  for (const p of request.props) {
    const name = clark(p.ns, p.local);
    const v = await valueOf(node, name, env);
    results.push(v === null ? { status: 404, prop: elementFor(name, [], p) } : { status: 200, prop: elementFor(name, v, p) });
  }
  return ordered(results);
}
