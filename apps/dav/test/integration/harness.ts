// A real DAV daemon on an ephemeral loopback port for the integration tests: a throwaway database
// (migrated with the real migrations, so the default-collection trigger runs), a fresh KEK, and
// accounts with app passwords. The client speaks plain HTTP the way cloudflared does: loopback is
// the trusted proxy, and X-Forwarded-Proto: https says the phone spoke TLS to Cloudflare.
import { randomInt } from 'node:crypto';
import { createAuthThrottle, type AuthThrottle } from '@postroom/auth-throttle';
import { createAppPassword, hashAppPassword } from '@postroom/credentials';
import { generateKek } from '@postroom/crypto';
import { AddressKind, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { NS, childElement, childElements, clark, parseXml, textContent, type XmlElement } from '@postroom/dav-proto';
import type { DavConfig } from '../../src/config.js';
import { createDavServer, type DavServer } from '../../src/server.js';

export const PEPPER = 'test-pepper-dav-0123456789abcdef';
export const WEB_PASSWORD = 'correct horse battery staple';
const OPERATOR = { kind: 'system', label: 'test' } as const;

export const TEST_CONFIG: DavConfig = {
  host: '127.0.0.1',
  port: 0,
  trustedProxies: ['127.0.0.0/8', '::1/128'],
  requireHttps: true,
  maxXmlBytes: 64 * 1024,
  maxResourceBytes: 128 * 1024,
  maxCollectionsPerAccount: 8,
  maxResourcesPerCollection: 1000,
  authCacheMs: 60_000,
};

export interface Account {
  readonly id: string;
  readonly address: string;
  readonly appPassword: string;
  readonly appPasswordId: string;
}

export interface Harness {
  readonly t: TestDatabase;
  readonly db: Db;
  readonly dav: DavServer;
  readonly base: string;
  /** Tarpit delays the throttle asked for (the sleep is a no-op so tests stay fast). */
  readonly sleeps: number[];
  readonly logs: { event: string; fields: Record<string, unknown> }[];
  /** Another server on the same database with different options. */
  serverWith(config: Partial<DavConfig>, throttle?: AuthThrottle): Promise<{ dav: DavServer; base: string }>;
  close(): Promise<void>;
}

export async function startHarness(prefix: string): Promise<Harness> {
  const t = await createTestDatabase(process.env['DATABASE_URL'] ?? '', prefix);
  const db = t.db;
  await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
  const kek = generateKek();
  const sleeps: number[] = [];
  const logs: Harness['logs'] = [];
  const open: DavServer[] = [];
  const start = async (config: DavConfig, throttle: AuthThrottle): Promise<{ dav: DavServer; base: string }> => {
    const dav = createDavServer({ db, kek, pepper: PEPPER, config, throttle, log: (event, fields = {}) => logs.push({ event, fields }) });
    open.push(dav);
    const address = await dav.listen(0, '127.0.0.1');
    return { dav, base: `http://127.0.0.1:${String(address.port)}` };
  };
  const throttle = createAuthThrottle({
    db,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    sourceCeiling: 12,
  });
  const main = await start(TEST_CONFIG, throttle);
  return {
    t,
    db,
    dav: main.dav,
    base: main.base,
    sleeps,
    logs,
    serverWith: (config, th) => start({ ...TEST_CONFIG, ...config }, th ?? throttle),
    close: async () => {
      for (const d of open) await d.close();
      await t.drop();
    },
  };
}

/** A person with a primary address, a web password, and an app password with the given scopes. */
export async function makeAccount(h: Harness, scopes: ('dav' | 'imap' | 'smtp')[] = ['dav']): Promise<Account> {
  const login = `u${randomInt(1e9).toString(36)}`;
  const d = await h.db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io' } });
  const account = await h.db.account.create({ data: { displayName: `User ${login}`, passwordHash: await hashAppPassword(WEB_PASSWORD, PEPPER) } });
  await h.db.address.create({ data: { localPart: login, domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
  const created = await createAppPassword(h.db, OPERATOR, { accountId: account.id, label: 'iPhone', scopes }, { pepper: PEPPER });
  return { id: account.id, address: `${login}@d3cloud.io`, appPassword: created.password, appPasswordId: created.appPassword.id };
}

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** The body parsed as XML, when it is XML. */
  readonly xml: XmlElement | null;
}

export interface Client {
  request(method: string, path: string, options?: { body?: string | Buffer; headers?: Record<string, string>; auth?: false | { user: string; pass: string } }): Promise<Reply>;
}

export function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

/** A client that talks like cloudflared forwarding an iPhone: HTTPS vouched for, real client IP set. */
export function client(base: string, account: Account | null, extra: Record<string, string> = {}): Client {
  return {
    async request(method, path, options = {}) {
      const headers: Record<string, string> = { 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '203.0.113.7', 'User-Agent': 'iOS/26.0 (23A341) dataaccessd/1.0', ...extra, ...(options.headers ?? {}) };
      const auth = options.auth ?? (account === null ? false : { user: account.address, pass: account.appPassword });
      if (auth !== false) headers['Authorization'] = basic(auth.user, auth.pass);
      if (options.body !== undefined && headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/xml; charset=utf-8';
      const res = await fetch(`${base}${path}`, { method, headers, redirect: 'manual', ...(options.body === undefined ? {} : { body: options.body }) });
      const text = await res.text();
      const type = res.headers.get('content-type') ?? '';
      return { status: res.status, headers: res.headers, text, xml: type.includes('xml') && text !== '' ? parseXml(text) : null };
    },
  };
}

export interface ResponseView {
  readonly href: string;
  /** The response's own status (multiget miss, sync tombstone), or null. */
  readonly status: number | null;
  /** Clark name → { status, element }. */
  readonly props: Map<string, { status: number; el: XmlElement }>;
}

function statusCode(e: XmlElement | undefined): number | null {
  if (e === undefined) return null;
  const m = /^HTTP\/1\.1 (\d{3})/.exec(textContent(e));
  return m?.[1] === undefined ? null : Number(m[1]);
}

/** A multistatus body as href → view, plus its sync-token. */
export function responses(xml: XmlElement | null): { byHref: Map<string, ResponseView>; list: ResponseView[]; syncToken: string | null } {
  if (xml === null || xml.ns !== NS.DAV || xml.local !== 'multistatus') throw new Error(`not a multistatus: ${JSON.stringify(xml).slice(0, 200)}`);
  const list: ResponseView[] = [];
  for (const r of childElements(xml, NS.DAV, 'response')) {
    const hrefEl = childElement(r, NS.DAV, 'href');
    const props = new Map<string, { status: number; el: XmlElement }>();
    for (const ps of childElements(r, NS.DAV, 'propstat')) {
      const st = statusCode(childElement(ps, NS.DAV, 'status')) ?? 0;
      const prop = childElement(ps, NS.DAV, 'prop');
      for (const p of prop === undefined ? [] : childElements(prop)) props.set(clark(p.ns, p.local), { status: st, el: p });
    }
    list.push({ href: hrefEl === undefined ? '' : textContent(hrefEl), status: statusCode(childElement(r, NS.DAV, 'status')), props });
  }
  const token = childElement(xml, NS.DAV, 'sync-token');
  return { byHref: new Map(list.map((v) => [v.href, v])), list, syncToken: token === undefined ? null : textContent(token) };
}

/** The text of a 200 property, or undefined. */
export function prop(view: ResponseView | undefined, ns: string, local: string): string | undefined {
  const p = view?.props.get(clark(ns, local));
  return p?.status === 200 ? textContent(p.el) : undefined;
}

/** The hrefs inside a 200 property. */
export function propHrefs(view: ResponseView | undefined, ns: string, local: string): string[] {
  const p = view?.props.get(clark(ns, local));
  if (p?.status !== 200) return [];
  return childElements(p.el, NS.DAV, 'href').map(textContent);
}
