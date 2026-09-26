// The DAV daemon's HTTP server (node:http): WebDAV (RFC 4918), CalDAV (RFC 4791), CardDAV
// (RFC 6352), sync-collection (RFC 6578), extended MKCOL (RFC 5689), well-known discovery (RFC 6764).
// PST-T-8.2, PST-REQ-132, PST-REQ-133.
//
//   PST-REQ-027  Basic credentials are checked by verifyProtocolLogin with scope 'dav': app passwords
//                only, never the account password.
//   PST-REQ-075  every credential check goes through the shared tarpit + throttle, audited.
//   PST-REQ-009  every mutation writes an audit row in its own transaction (store.ts).
//
// TLS terminates at Cloudflare; the tunnel reaches this daemon over plain HTTP. X-Forwarded-Proto
// and CF-Connecting-IP are believed only from a trusted proxy (the cloudflared container), and by
// default credentials are refused unless such a proxy says the client spoke HTTPS — so an app
// password is never accepted in the clear. Bodies are read as a stream with a byte cap and refused
// the moment they pass it; the XML parser refuses every DTD.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isIP } from 'node:net';
import { createAuthThrottle, type AuthThrottle } from '@postroom/auth-throttle';
import type { Kek } from '@postroom/crypto';
import type { Db } from '@postroom/db';
import {
  DavRequestError,
  NS,
  PROPFIND_FINITE_DEPTH,
  XmlError,
  clark,
  davError,
  decodePath,
  el,
  evaluatePreconditions,
  formatEtag,
  hrefElement,
  hrefPath,
  multistatus,
  parseClark,
  parseDepth,
  parseMkcol,
  parsePropfind,
  parseProppatch,
  parseReport,
  parseXml,
  serializeXml,
  statusLine,
  type AddressbookQuery,
  type CalendarQuery,
  type Multiget,
  type MultiStatusResponse,
  type PropRequest,
  type SyncCollection,
  type XmlElement,
} from '@postroom/dav-proto';
import { parseICalendar } from '@postroom/ical';
import { parseVCard } from '@postroom/vcard';
import { createDavAuthenticator, parseBasicAuth, type DavAuthenticator } from './auth.js';
import { trustedProxyList, type DavConfig } from './config.js';
import { calendarMatches, cardMatches } from './filters.js';
import { CONTEXT_PATH, collectionHref, objectHref, route, targetHref, type Target } from './paths.js';
import { applyUpdates, resourcetypeKind } from './proppatch.js';
import { parseSyncToken, propstatsFor, syncToken, type Node, type PropEnv } from './props.js';
import { DavStore, type Caller, type Collection, type Kind, type Resource, type ResourceMeta } from './store.js';
import { validateCalendarObject, validateVCard, validResourceName } from './validate.js';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface DavServerOptions {
  readonly db: Db;
  readonly kek: Kek;
  /** PASSWORD_PEPPER; without it every login is refused as unavailable. */
  readonly pepper: string | undefined;
  readonly config: DavConfig;
  readonly throttle?: AuthThrottle;
  readonly log?: Log;
}

export interface DavServer {
  readonly server: Server;
  readonly store: DavStore;
  readonly authenticate: DavAuthenticator & { forget(): void };
  listen(port: number, host: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

export const DAV_HEADER = '1, 3, extended-mkcol, calendar-access, addressbook';
export const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MKCALENDAR, REPORT';
const XML_TYPE = 'application/xml; charset=utf-8';
const REALM = 'Basic realm="Postroom", charset="UTF-8"';

/** A body over its cap. `condition` (e.g. CALDAV:max-resource-size) turns the 413 into a 403 + DAV:error. */
class BodyTooLarge extends Error {
  constructor(readonly condition: string | undefined) {
    super('request body too large');
  }
}

/** Read a request body as a stream, refusing it as soon as it passes `max` bytes. */
async function readBody(req: IncomingMessage, max: number, condition?: string): Promise<Buffer> {
  const encoding = req.headers['content-encoding'];
  if (encoding !== undefined && encoding.toLowerCase() !== 'identity') throw new DavRequestError(415, 'compressed request bodies are not accepted');
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > max) throw new BodyTooLarge(condition);
  // Events rather than for-await: leaving a for-await loop destroys the request (and with it the
  // socket) before the refusal can be written. Here the stream is paused instead, the answer goes
  // out with Connection: close, and the rest of the body is never read.
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > max) {
        cleanup();
        req.pause();
        reject(new BodyTooLarge(condition));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('client went away mid-body'));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

function sendXml(res: ServerResponse, status: number, tree: XmlElement, headers: Record<string, string> = {}): void {
  const body = Buffer.from(serializeXml(tree), 'utf8');
  res.writeHead(status, { 'Content-Type': XML_TYPE, 'Content-Length': String(body.length), ...headers });
  res.end(body);
}

function sendStatus(res: ServerResponse, status: number, headers: Record<string, string> = {}, text?: string): void {
  if (text === undefined) {
    res.writeHead(status, { 'Content-Length': '0', ...headers });
    res.end();
    return;
  }
  const body = Buffer.from(`${text}\n`, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(body.length), ...headers });
  res.end(body);
}

function sendCondition(res: ServerResponse, status: number, condition: XmlElement | string, headers: Record<string, string> = {}): void {
  sendXml(res, status, davError(condition), headers);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(', ') : v;
}

function preconditionsOf(req: IncomingMessage): { ifMatch?: string; ifNoneMatch?: string } {
  const ifMatch = header(req, 'if-match');
  const ifNoneMatch = header(req, 'if-none-match');
  return { ...(ifMatch === undefined ? {} : { ifMatch }), ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }) };
}

function isEmpty(body: Buffer): boolean {
  return body.every((b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d);
}

function needsData(props: PropRequest): boolean {
  return props.kind === 'prop' && props.props.some((p) => (p.ns === NS.CALDAV && p.local === 'calendar-data') || (p.ns === NS.CARDDAV && p.local === 'address-data'));
}

const DEFAULT_NAMES: Readonly<Record<Kind, string>> = { calendar: 'Calendar', addressbook: 'Contacts' };

interface Session {
  readonly accountId: string;
  readonly caller: Caller;
  readonly env: PropEnv;
}

export function createDavServer(o: DavServerOptions): DavServer {
  const log: Log = o.log ?? (() => undefined);
  const config = o.config;
  const store = new DavStore(o.db, o.kek, config);
  const trusted = trustedProxyList(config.trustedProxies);
  const authenticate = createDavAuthenticator({
    db: o.db,
    pepper: o.pepper,
    throttle: o.throttle ?? createAuthThrottle({ db: o.db }),
    cacheMs: config.authCacheMs,
  });

  /** The client's address and whether it spoke HTTPS, believing forwarding headers only from a trusted proxy. */
  function clientOf(req: IncomingMessage): { ip: string; https: boolean } {
    const peer = req.socket.remoteAddress ?? '';
    if (!trusted(peer)) return { ip: peer, https: false };
    const cf = header(req, 'cf-connecting-ip')?.trim();
    const xff = header(req, 'x-forwarded-for')?.split(',').pop()?.trim();
    const forwarded = cf !== undefined && isIP(cf) !== 0 ? cf : xff !== undefined && isIP(xff) !== 0 ? xff : peer;
    const proto = header(req, 'x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
    return { ip: forwarded, https: proto === 'https' };
  }

  // ---- resolving targets to nodes ----

  async function collectionOf(accountId: string, kind: Kind, slug: string): Promise<Collection | null> {
    return store.getCollection(accountId, kind, slug);
  }

  function objectNode(collection: Collection, meta: ResourceMeta, preloaded?: Buffer): Node {
    let data: Promise<Buffer> | undefined = preloaded === undefined ? undefined : Promise.resolve(preloaded);
    return {
      type: 'object',
      collection,
      meta,
      data: () => {
        data ??= store.getResources(collection.id, [meta.name]).then((r) => {
          const first = r[0];
          if (first === undefined) throw new DavRequestError(404, 'resource vanished');
          return first.data;
        });
        return data;
      },
    };
  }

  async function nodeOf(accountId: string, t: Target): Promise<Node | null> {
    switch (t.type) {
      case 'root':
        return { type: 'root' };
      case 'principal':
        return { type: 'principal' };
      case 'home':
        return { type: 'home', kind: t.kind };
      case 'collection': {
        const c = await collectionOf(accountId, t.kind, t.slug);
        return c === null ? null : { type: 'collection', collection: c };
      }
      case 'object': {
        const c = await collectionOf(accountId, t.kind, t.slug);
        if (c === null) return null;
        const meta = await store.getMeta(c.id, t.name);
        return meta === null ? null : objectNode(c, meta);
      }
    }
  }

  // ---- methods ----

  async function propfind(req: IncomingMessage, res: ServerResponse, s: Session, t: Target): Promise<void> {
    const depth = parseDepth(header(req, 'depth'), 'infinity');
    if (depth === 'infinity') {
      sendCondition(res, 403, PROPFIND_FINITE_DEPTH);
      return;
    }
    const body = await readBody(req, config.maxXmlBytes);
    const request = parsePropfind(isEmpty(body) ? null : parseXml(body, { maxBytes: config.maxXmlBytes }));
    const node = await nodeOf(s.accountId, t);
    if (node === null) {
      sendStatus(res, 404);
      return;
    }
    const entries: { href: string; node: Node }[] = [{ href: targetHref(s.accountId, t), node }];
    if (depth === 1) {
      if (node.type === 'home') {
        for (const c of await store.listCollections(s.accountId, node.kind)) {
          entries.push({ href: collectionHref(s.accountId, c.kind, c.slug), node: { type: 'collection', collection: c } });
        }
      } else if (node.type === 'collection') {
        for (const m of await store.listResources(node.collection.id)) {
          entries.push({ href: objectHref(s.accountId, node.collection.kind, node.collection.slug, m.name), node: objectNode(node.collection, m) });
        }
      }
    }
    const responses: MultiStatusResponse[] = [];
    for (const e of entries) responses.push({ href: e.href, propstats: await propstatsFor(e.node, request, s.env) });
    sendXml(res, 207, multistatus(responses));
  }

  async function proppatch(req: IncomingMessage, res: ServerResponse, s: Session, t: Target): Promise<void> {
    const body = await readBody(req, config.maxXmlBytes);
    if (isEmpty(body)) throw new DavRequestError(400, 'PROPPATCH needs a body');
    const updates = parseProppatch(parseXml(body, { maxBytes: config.maxXmlBytes }));
    if (t.type !== 'collection') {
      const node = await nodeOf(s.accountId, t);
      if (node === null) sendStatus(res, 404);
      else sendCondition(res, 403, clark(NS.DAV, 'cannot-modify-protected-property'));
      return;
    }
    const collection = await collectionOf(s.accountId, t.kind, t.slug);
    if (collection === null) {
      sendStatus(res, 404);
      return;
    }
    const result = applyUpdates(collection, updates, t.kind, false, DEFAULT_NAMES[t.kind]);
    if (result.ok) await store.updateCollection(s.caller, collection, result.fields);
    sendXml(res, 207, multistatus([{ href: targetHref(s.accountId, t), propstats: outcomesToPropstats(result.outcomes) }]));
  }

  function outcomesToPropstats(outcomes: readonly { prop: XmlElement; status: number; condition?: string }[]): { status: number; props: XmlElement[]; error?: XmlElement }[] {
    const out: { status: number; props: XmlElement[]; error?: XmlElement }[] = [];
    for (const o of outcomes) {
      const cond = o.condition === undefined ? undefined : parseClark(o.condition);
      const error = cond === null || cond === undefined ? undefined : el(cond.ns, cond.local);
      const same = out.find((p) => p.status === o.status && p.error?.local === error?.local);
      if (same !== undefined) same.props.push(o.prop);
      else out.push({ status: o.status, props: [o.prop], ...(error === undefined ? {} : { error }) });
    }
    return out;
  }

  async function mkcollection(req: IncomingMessage, res: ServerResponse, s: Session, t: Target, method: 'MKCALENDAR' | 'MKCOL'): Promise<void> {
    const body = await readBody(req, config.maxXmlBytes);
    const props = parseMkcol(isEmpty(body) ? null : parseXml(body, { maxBytes: config.maxXmlBytes }), method);
    if (t.type !== 'collection' || (method === 'MKCALENDAR' && t.kind !== 'calendar')) {
      sendStatus(res, t.type === 'object' ? 409 : 403);
      return;
    }
    if (method === 'MKCOL') {
      const kind = resourcetypeKind(props);
      if (kind !== t.kind) {
        // Plain WebDAV collections are not supported; only calendars in the calendar home and
        // address books in the address book home.
        sendCondition(res, 403, clark(NS.DAV, 'valid-resourcetype'));
        return;
      }
    }
    if (!validResourceName(t.slug)) throw new DavRequestError(400, 'invalid collection name');
    if ((await collectionOf(s.accountId, t.kind, t.slug)) !== null) {
      if (method === 'MKCALENDAR') sendCondition(res, 403, clark(NS.DAV, 'resource-must-be-null'));
      else sendStatus(res, 405, { Allow: ALLOW });
      return;
    }
    const base = { displayName: t.slug, description: null, color: null, sortOrder: null, components: t.kind === 'calendar' ? ['VEVENT', 'VTODO'] : [], deadProps: {} };
    const result = applyUpdates(base, props.map((prop) => ({ action: 'set' as const, prop })), t.kind, true, t.slug);
    if (!result.ok) {
      const root = method === 'MKCALENDAR' ? el(NS.CALDAV, 'mkcalendar-response') : el(NS.DAV, 'mkcol-response');
      for (const ps of outcomesToPropstats(result.outcomes)) {
        const kids: XmlElement[] = [el(NS.DAV, 'prop', ps.props), el(NS.DAV, 'status', [statusLine(ps.status)])];
        if (ps.error !== undefined) kids.push(el(NS.DAV, 'error', [ps.error]));
        root.children.push(el(NS.DAV, 'propstat', kids));
      }
      sendXml(res, 403, root);
      return;
    }
    const created = await store.createCollection(s.caller, t.kind, t.slug, result.fields);
    if (created === 'full') sendStatus(res, 507, {}, 'too many collections');
    else if (created === null) sendStatus(res, 405, { Allow: ALLOW });
    else sendStatus(res, 201, { Location: targetHref(s.accountId, t) });
  }

  async function del(req: IncomingMessage, res: ServerResponse, s: Session, t: Target): Promise<void> {
    if (t.type === 'object') {
      const collection = await collectionOf(s.accountId, t.kind, t.slug);
      if (collection === null) {
        sendStatus(res, 404);
        return;
      }
      const outcome = await store.deleteResource(s.caller, collection, t.name, preconditionsOf(req));
      sendStatus(res, outcome === 'deleted' ? 204 : outcome === 'not-found' ? 404 : 412);
      return;
    }
    if (t.type === 'collection') {
      const collection = await collectionOf(s.accountId, t.kind, t.slug);
      if (collection === null) {
        sendStatus(res, 404);
        return;
      }
      await store.deleteCollection(s.caller, collection);
      sendStatus(res, 204);
      return;
    }
    sendStatus(res, 403);
  }

  async function get(req: IncomingMessage, res: ServerResponse, s: Session, t: Target, head: boolean): Promise<void> {
    if (t.type !== 'object') {
      const node = await nodeOf(s.accountId, t);
      sendStatus(res, node === null ? 404 : 405, node === null ? {} : { Allow: ALLOW });
      return;
    }
    const collection = await collectionOf(s.accountId, t.kind, t.slug);
    const resource = collection === null ? undefined : (await store.getResources(collection.id, [t.name]))[0];
    if (collection === null || resource === undefined) {
      sendStatus(res, 404);
      return;
    }
    const pre = evaluatePreconditions(preconditionsOf(req), resource.etag, head ? 'HEAD' : 'GET');
    if (pre !== null) {
      sendStatus(res, pre, { ETag: formatEtag(resource.etag) });
      return;
    }
    res.writeHead(200, {
      'Content-Type': collection.kind === 'calendar' ? 'text/calendar; charset=utf-8' : 'text/vcard; charset=utf-8',
      'Content-Length': String(resource.data.length),
      ETag: formatEtag(resource.etag),
      'Last-Modified': resource.updatedAt.toUTCString(),
      'Cache-Control': 'private, no-cache',
    });
    res.end(head ? undefined : resource.data);
  }

  async function put(req: IncomingMessage, res: ServerResponse, s: Session, t: Target): Promise<void> {
    if (t.type !== 'object') {
      sendStatus(res, t.type === 'collection' ? 405 : 403, { Allow: ALLOW });
      return;
    }
    const collection = await collectionOf(s.accountId, t.kind, t.slug);
    if (collection === null) {
      sendStatus(res, 409, {}, 'no such collection');
      return;
    }
    if (!validResourceName(t.name)) throw new DavRequestError(400, 'invalid resource name');
    const ns = t.kind === 'calendar' ? NS.CALDAV : NS.CARDDAV;
    const body = await readBody(req, config.maxResourceBytes, clark(ns, 'max-resource-size'));
    const contentType = header(req, 'content-type');
    let uid: string;
    let componentType: string | null = null;
    if (t.kind === 'calendar') {
      const v = validateCalendarObject(body, contentType, collection.components, config.maxResourceBytes);
      uid = v.uid;
      componentType = v.componentType;
    } else {
      uid = validateVCard(body, contentType, config.maxResourceBytes).uid;
    }
    const outcome = await store.putResource(s.caller, collection, { name: t.name, uid, componentType, data: body, preconditions: preconditionsOf(req) });
    switch (outcome.status) {
      case 'created':
      case 'updated':
        // The bytes are stored exactly as sent, so the ETag may be returned (RFC 4791 §5.3.4).
        sendStatus(res, outcome.status === 'created' ? 201 : 204, { ETag: formatEtag(outcome.etag) });
        return;
      case 'precondition-failed':
        sendStatus(res, 412);
        return;
      case 'uid-conflict':
        sendCondition(res, 403, el(ns, 'no-uid-conflict', [hrefElement(objectHref(s.accountId, t.kind, t.slug, outcome.existingName))]));
        return;
      case 'collection-gone':
        sendStatus(res, 409, {}, 'no such collection');
        return;
      case 'collection-full':
        sendStatus(res, 507, {}, 'collection is full');
        return;
    }
  }

  // ---- REPORT ----

  async function report(req: IncomingMessage, res: ServerResponse, s: Session, t: Target): Promise<void> {
    const body = await readBody(req, config.maxXmlBytes);
    if (isEmpty(body)) throw new DavRequestError(400, 'REPORT needs a body');
    const r = parseReport(parseXml(body, { maxBytes: config.maxXmlBytes }));
    if (r.kind === 'unsupported') {
      sendCondition(res, 403, clark(NS.DAV, 'supported-report'));
      return;
    }
    if (t.type !== 'collection') {
      const node = await nodeOf(s.accountId, t);
      if (node === null) sendStatus(res, 404);
      else sendCondition(res, 403, clark(NS.DAV, 'supported-report'));
      return;
    }
    const collection = await collectionOf(s.accountId, t.kind, t.slug);
    if (collection === null) {
      sendStatus(res, 404);
      return;
    }
    const calendarReport = r.kind === 'calendar-query' || r.kind === 'calendar-multiget';
    const cardReport = r.kind === 'addressbook-query' || r.kind === 'addressbook-multiget';
    if ((calendarReport && collection.kind !== 'calendar') || (cardReport && collection.kind !== 'addressbook')) {
      sendCondition(res, 403, clark(NS.DAV, 'supported-report'));
      return;
    }
    const depth = parseDepth(header(req, 'depth'), 1);
    switch (r.kind) {
      case 'sync-collection':
        await syncCollection(res, s, collection, r);
        return;
      case 'calendar-multiget':
      case 'addressbook-multiget':
        await multiget(res, s, collection, r);
        return;
      case 'calendar-query':
        await query(res, s, collection, r, depth);
        return;
      case 'addressbook-query':
        await query(res, s, collection, r, depth);
        return;
    }
  }

  async function responsesFor(s: Session, collection: Collection, resources: readonly (Resource | ResourceMeta)[], props: PropRequest): Promise<MultiStatusResponse[]> {
    const out: MultiStatusResponse[] = [];
    for (const r of resources) {
      const node = objectNode(collection, r, 'data' in r ? r.data : undefined);
      const propstats = await propstatsFor(node, props, s.env);
      const href = objectHref(s.accountId, collection.kind, collection.slug, r.name);
      out.push(propstats.length === 0 ? { href, status: 200 } : { href, propstats });
    }
    return out;
  }

  async function multiget(res: ServerResponse, s: Session, collection: Collection, r: Multiget): Promise<void> {
    const wanted: { href: string; name: string | null }[] = r.hrefs.map((h) => {
      const path = hrefPath(h);
      if (path === null) return { href: h, name: null };
      try {
        const rt = route(decodePath(path).segments);
        if (rt.type !== 'dav' || rt.accountId !== s.accountId || rt.target.type !== 'object') return { href: h, name: null };
        const inside = rt.target.kind === collection.kind && rt.target.slug === collection.slug;
        return { href: h, name: inside ? rt.target.name : null };
      } catch (err) {
        if (err instanceof DavRequestError) return { href: h, name: null };
        throw err;
      }
    });
    const names = wanted.flatMap((w) => (w.name === null ? [] : [w.name]));
    const found = needsData(r.props) ? await store.getResources(collection.id, names) : await listMeta(collection.id, names);
    const byName = new Map<string, Resource | ResourceMeta>(found.map((f) => [f.name, f]));
    const responses: MultiStatusResponse[] = [];
    for (const w of wanted) {
      const hit = w.name === null ? undefined : byName.get(w.name);
      if (hit === undefined) {
        responses.push({ href: w.href, status: 404 });
        continue;
      }
      // The href exactly as the client wrote it, so it can match its own request (absolute URL,
      // its own percent-encoding) without normalising ours.
      const [one] = await responsesFor(s, collection, [hit], r.props);
      if (one !== undefined) responses.push({ ...one, href: w.href });
    }
    sendXml(res, 207, multistatus(responses));
  }

  async function listMeta(collectionId: string, names: readonly string[]): Promise<ResourceMeta[]> {
    const set = new Set(names);
    return (await store.listResources(collectionId)).filter((m) => set.has(m.name));
  }

  async function query(res: ServerResponse, s: Session, collection: Collection, r: CalendarQuery | AddressbookQuery, depth: 0 | 1 | 'infinity'): Promise<void> {
    // Depth: 0 on a collection asks about the collection itself, which is never a calendar object.
    const all = depth === 0 ? [] : await store.getResources(collection.id);
    const matches: Resource[] = [];
    for (const res0 of all) {
      if (r.kind === 'calendar-query') {
        const root = safeParse(() => parseICalendar(res0.data));
        if (root !== null && calendarMatches(root, r.filter)) matches.push(res0);
      } else {
        const card = safeParse(() => parseVCard(res0.data));
        if (card !== null && cardMatches(card, r.filter)) matches.push(res0);
      }
    }
    const limit = r.kind === 'addressbook-query' ? r.limit : null;
    const truncated = limit !== null && matches.length > limit;
    const responses = await responsesFor(s, collection, truncated ? matches.slice(0, limit) : matches, r.props);
    if (truncated) {
      responses.push({ href: collectionHref(s.accountId, collection.kind, collection.slug), status: 507, error: el(NS.DAV, 'number-of-matches-within-limits') });
    }
    sendXml(res, 207, multistatus(responses));
  }

  function safeParse<T>(f: () => T): T | null {
    try {
      return f();
    } catch (err) {
      // Stored data was validated on the way in; a parser that tightened since must not break a query.
      log('stored-object-unparseable', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  async function syncCollection(res: ServerResponse, s: Session, collection: Collection, r: SyncCollection): Promise<void> {
    // The current sequence is read BEFORE the members: anything written in between is reported
    // now and again next time (harmless), never missed.
    const current = (await store.currentSeq(collection.id)) ?? collection.syncSeq;
    const responses: MultiStatusResponse[] = [];
    let token = current;
    let truncated = false;
    const withData = needsData(r.props);

    if (r.syncToken === '') {
      let members = (await store.listResources(collection.id)).filter((m) => m.modSeq <= current);
      if (r.limit !== null && members.length > r.limit) {
        members = members.slice(0, r.limit);
        truncated = true;
        token = members.length === 0 ? 0n : (members[members.length - 1]?.modSeq ?? 0n);
      }
      const rows = withData ? await store.getResources(collection.id, members.map((m) => m.name)) : members;
      responses.push(...(await responsesFor(s, collection, rows, r.props)));
    } else {
      const parsed = parseSyncToken(r.syncToken);
      if (parsed === null || parsed.collectionId !== collection.id || parsed.seq > current) {
        sendCondition(res, 403, clark(NS.DAV, 'valid-sync-token'));
        return;
      }
      const changes = await store.changesBetween(collection.id, parsed.seq, current);
      const latest = new Map<string, boolean>();
      for (const c of changes) {
        if (!latest.has(c.name) && r.limit !== null && latest.size >= r.limit) {
          truncated = true;
          token = c.seq - 1n;
          break;
        }
        // Map order is first-insertion order; delete + set keeps the order of the LAST change.
        latest.delete(c.name);
        latest.set(c.name, c.deleted);
      }
      const live = [...latest].filter(([, deleted]) => !deleted).map(([name]) => name);
      const rows = withData ? await store.getResources(collection.id, live) : await listMeta(collection.id, live);
      const byName = new Map<string, Resource | ResourceMeta>(rows.map((row) => [row.name, row]));
      for (const [name, deleted] of latest) {
        const row = deleted ? undefined : byName.get(name);
        // A removed member is a response with a bare 404 status (RFC 6578 §3.5.2).
        if (row === undefined) responses.push({ href: objectHref(s.accountId, collection.kind, collection.slug, name), status: 404 });
        else responses.push(...(await responsesFor(s, collection, [row], r.props)));
      }
    }
    if (truncated) {
      responses.push({ href: collectionHref(s.accountId, collection.kind, collection.slug), status: 507, error: el(NS.DAV, 'number-of-matches-within-limits') });
    }
    sendXml(res, 207, multistatus(responses, syncToken(collection.id, token)));
  }

  // ---- dispatch ----

  async function handle(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://dav.invalid');
    const route0 = route(decodePath(url.pathname).segments);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (route0.type === 'well-known') {
      // RFC 6764 §5: redirect to the context path, for any method (clients PROPFIND it).
      sendStatus(res, 301, { Location: CONTEXT_PATH });
      return;
    }
    if (method === 'OPTIONS') {
      sendStatus(res, 200, { DAV: DAV_HEADER, Allow: ALLOW, 'MS-Author-Via': 'DAV' });
      return;
    }
    if (route0.type === 'not-found') {
      sendStatus(res, 404);
      return;
    }

    const client = clientOf(req);
    if (config.requireHttps && !client.https) {
      // The credentials are not even looked at: they already crossed the network in the clear.
      sendStatus(res, 403, { Connection: 'close' }, 'DAV requires HTTPS');
      return;
    }
    const credentials = parseBasicAuth(header(req, 'authorization'));
    if (credentials === null) {
      sendStatus(res, 401, { 'WWW-Authenticate': REALM });
      return;
    }
    const auth = await authenticate(credentials, client.ip, signal);
    if (!auth.ok) {
      if (auth.kind === 'aborted') return;
      if (auth.kind === 'locked') sendStatus(res, 429, { 'Retry-After': '300' }, 'too many failed logins');
      else if (auth.kind === 'unavailable') sendStatus(res, 503, { 'Retry-After': '60' });
      else sendStatus(res, 401, { 'WWW-Authenticate': REALM });
      return;
    }
    if (route0.accountId !== null && route0.accountId !== auth.accountId) {
      sendStatus(res, 404);
      return;
    }

    const accountId = auth.accountId;
    let principal: Promise<{ displayName: string; addresses: string[] }> | undefined;
    const session: Session = {
      accountId,
      caller: { accountId, context: { requestId: randomUUID(), ip: client.ip, userAgent: header(req, 'user-agent')?.slice(0, 512) ?? null } },
      env: {
        accountId,
        maxResourceBytes: config.maxResourceBytes,
        principal: () => (principal ??= store.principal(accountId)),
      },
    };
    const t = route0.target;
    switch (method) {
      case 'PROPFIND':
        return propfind(req, res, session, t);
      case 'PROPPATCH':
        return proppatch(req, res, session, t);
      case 'MKCALENDAR':
        return mkcollection(req, res, session, t, 'MKCALENDAR');
      case 'MKCOL':
        return mkcollection(req, res, session, t, 'MKCOL');
      case 'DELETE':
        return del(req, res, session, t);
      case 'GET':
        return get(req, res, session, t, false);
      case 'HEAD':
        return get(req, res, session, t, true);
      case 'PUT':
        return put(req, res, session, t);
      case 'REPORT':
        return report(req, res, session, t);
      default:
        sendStatus(res, 405, { Allow: ALLOW });
    }
  }

  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    handle(req, res, controller.signal).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof BodyTooLarge) {
        // Stop reading: the rest of the body is not wanted, and the connection cannot be reused.
        if (err.condition === undefined) sendStatus(res, 413, { Connection: 'close' });
        else sendCondition(res, 403, err.condition, { Connection: 'close' });
        return;
      }
      if (err instanceof DavRequestError) {
        if (err.condition === undefined) sendStatus(res, err.status, {}, err.message);
        else sendCondition(res, err.status, err.condition);
        return;
      }
      if (err instanceof XmlError) {
        sendStatus(res, 400, {}, `malformed XML: ${err.message}`);
        return;
      }
      log('request-error', { method: req.method, error: err instanceof Error ? err.message : String(err) });
      sendStatus(res, 500);
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 60_000;

  return {
    server,
    store,
    authenticate,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
