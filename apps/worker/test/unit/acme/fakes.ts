// Fakes for the ACME job's tests (PST-T-0.15): an in-process RFC 8555 server that VERIFIES every
// JWS it is sent (so the client's signing is really tested), a Cloudflare DNS API, and the DNS the
// job and the CA both see. Everything binds 127.0.0.1 on an ephemeral port; nothing leaves the host.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChallengeDns } from '../../../src/acme/dns.js';
import { contextConstructed, contextPrimitive, integer, oid, sequence, setOf, tlv, utf8String, bitString, octetString } from '../../../src/acme/der.js';

// ---- a minimal DER reader, independent of the code under test's writer ----

export interface Node {
  readonly tag: number;
  readonly raw: Buffer;
  readonly content: Buffer;
}

export function readNode(buf: Buffer, offset = 0): Node & { end: number } {
  const tag = buf[offset] ?? -1;
  let len = buf[offset + 1] ?? 0;
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (buf[offset + 2 + i] ?? 0);
    header += n;
  }
  const end = offset + header + len;
  if (end > buf.length) throw new Error('DER: truncated');
  return { tag, raw: buf.subarray(offset, end), content: buf.subarray(offset + header, end), end };
}

export function kids(node: Node): Node[] {
  const out: Node[] = [];
  for (let off = 0; off < node.content.length; ) {
    const n = readNode(node.content, off);
    out.push(n);
    off = n.end;
  }
  return out;
}

const at = (nodes: Node[], i: number): Node => {
  const n = nodes[i];
  if (n === undefined) throw new Error(`DER: no element ${String(i)}`);
  return n;
};

export interface ParsedCsr {
  readonly cn: string;
  readonly sans: string[];
  readonly publicKey: KeyObject;
  readonly spki: Buffer;
  readonly signatureValid: boolean;
  readonly algorithmOid: Buffer;
}

/** Parse and verify a PKCS#10 request the way a CA would. */
export function parseCsr(der: Buffer): ParsedCsr {
  const outer = kids(readNode(der));
  const info = at(outer, 0);
  const [version, subject, spkiNode, attrs] = kids(info);
  if (version === undefined || subject === undefined || spkiNode === undefined || attrs?.tag !== 0xa0) throw new Error('CSR: bad info');
  const rdn = at(kids(at(kids(subject), 0)), 0);
  const cn = at(kids(rdn), 1).content.toString('utf8');
  const attr = at(kids(attrs), 0);
  const extensions = at(kids(at(kids(attr), 1)), 0);
  const sans: string[] = [];
  for (const ext of kids(extensions)) {
    const [extOid, value] = kids(ext);
    if (extOid?.raw.equals(oid('2.5.29.17')) === true && value !== undefined) {
      for (const gn of kids(readNode(value.content))) if (gn.tag === 0x82) sans.push(gn.content.toString('ascii'));
    }
  }
  const publicKey = createPublicKey({ key: spkiNode.raw, format: 'der', type: 'spki' });
  const algorithm = at(outer, 1);
  const sigBits = at(outer, 2).content.subarray(1);
  const signatureValid = verify('sha256', info.raw, publicKey, sigBits);
  return { cn, sans, publicKey, spki: Buffer.from(spkiNode.raw), signatureValid, algorithmOid: Buffer.from(at(kids(algorithm), 0).raw) };
}

// ---- X.509 certificates for the fake CA and the renewal tests ----

function utcTime(d: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

const name = (cn: string): Buffer => sequence(setOf(sequence(oid('2.5.4.3'), utf8String(cn))));

export interface CertSpec {
  readonly spki: Buffer;
  readonly domains: readonly string[];
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly issuerKey: KeyObject;
  readonly issuer?: string;
}

/** A certificate signed ECDSA-SHA256 by `issuerKey`, PEM. */
export function makeCert(spec: CertSpec): string {
  const alg = sequence(oid('1.2.840.10045.4.3.2'));
  const san = sequence(...spec.domains.map((d) => contextPrimitive(2, Buffer.from(d, 'ascii'))));
  const tbs = sequence(
    contextConstructed(0, integer(2)),
    integer(BigInt(`0x${randomBytes(8).toString('hex')}`) | 1n),
    alg,
    name(spec.issuer ?? 'Fake ACME CA'),
    sequence(utcTime(spec.notBefore), utcTime(spec.notAfter)),
    name(spec.domains[0] ?? 'none'),
    spec.spki,
    contextConstructed(3, sequence(sequence(oid('2.5.29.17'), octetString(san)))),
  );
  const cert = sequence(tbs, alg, bitString(sign('sha256', tbs, spec.issuerKey)));
  const b64 = cert.toString('base64').replace(/.{64}/g, '$&\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END CERTIFICATE-----\n`;
}

/** A key pair and a matching certificate for `domains`, valid until now + `days`. */
export function makePair(domains: readonly string[], days: number, now = new Date()): { keyPem: string; certPem: string; key: KeyObject } {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const certPem = makeCert({ spki, domains, notBefore: new Date(now.getTime() - 86_400_000), notAfter: new Date(now.getTime() + days * 86_400_000), issuerKey: ca });
  return { keyPem: key.export({ type: 'pkcs8', format: 'pem' }).toString(), certPem, key };
}

// ---- the DNS both the job and the fake CA see ----

export interface FakeDnsState {
  cnames: Map<string, string>;
  servers: string[];
  /** Per server, how many txtAt calls answer empty before the record shows (propagation lag). */
  lag: Map<string, number>;
  /** Never serve the TXT at all (it never propagates). */
  neverVisible: boolean;
  txtCalls: number;
}

export function fakeDns(cf: FakeCloudflare, init: Partial<FakeDnsState> = {}): ChallengeDns & { state: FakeDnsState } {
  const state: FakeDnsState = {
    cnames: init.cnames ?? new Map([['_acme-challenge.mx.d3cloud.io', 'mx.d3cloud.io.bigfluffymurderbuffalo.com']]),
    servers: init.servers ?? ['192.0.2.53', '198.51.100.53'],
    lag: init.lag ?? new Map<string, number>(),
    neverVisible: init.neverVisible ?? false,
    txtCalls: 0,
  };
  return {
    state,
    cname: (n) => Promise.resolve(state.cnames.get(n) ?? null),
    authoritativeServers: () => Promise.resolve([...state.servers]),
    txtAt: (server, n) => {
      state.txtCalls++;
      const left = state.lag.get(server) ?? 0;
      if (left > 0) {
        state.lag.set(server, left - 1);
        return Promise.resolve([]);
      }
      if (state.neverVisible) return Promise.resolve([]);
      return Promise.resolve(cf.txt(n));
    },
  };
}

// ---- a fake Cloudflare DNS API ----

export interface FakeCloudflare {
  readonly baseUrl: string;
  readonly records: Map<string, { name: string; content: string; ttl: number }>;
  readonly ops: { op: 'create' | 'delete' | 'list'; name?: string; id?: string }[];
  txt(name: string): string[];
  failDelete: boolean;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
    });
  });
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });

export async function startFakeCloudflare(opts: { token: string; zoneId: string }): Promise<FakeCloudflare> {
  const records = new Map<string, { name: string; content: string; ttl: number }>();
  const ops: FakeCloudflare['ops'] = [];
  const fake = { failDelete: false } as { failDelete: boolean };
  const send = (res: ServerResponse, status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = /^\/client\/v4\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(url.pathname);
      // Scoped token: any other zone is a 403, exactly like a token limited to one zone.
      if (req.headers.authorization !== `Bearer ${opts.token}` || m === null || m[1] !== opts.zoneId) {
        send(res, 403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
        return;
      }
      const id = m[2];
      if (req.method === 'POST' && id === undefined) {
        const rec = JSON.parse(await body(req)) as { type: string; name: string; content: string; ttl: number };
        const newId = randomBytes(8).toString('hex');
        records.set(newId, { name: rec.name, content: rec.content, ttl: rec.ttl });
        ops.push({ op: 'create', name: rec.name, id: newId });
        send(res, 200, { success: true, errors: [], result: { id: newId, ...rec } });
      } else if (req.method === 'GET' && id === undefined) {
        const n = url.searchParams.get('name');
        ops.push({ op: 'list', ...(n === null ? {} : { name: n }) });
        send(res, 200, { success: true, errors: [], result: [...records].filter(([, r]) => r.name === n).map(([rid, r]) => ({ id: rid, ...r })) });
      } else if (req.method === 'DELETE' && id !== undefined) {
        ops.push({ op: 'delete', id });
        if (fake.failDelete) {
          send(res, 500, { success: false, errors: [{ code: 1000, message: 'boom' }] });
          return;
        }
        if (!records.delete(id)) {
          send(res, 404, { success: false, errors: [{ code: 81044, message: 'Record does not exist.' }] });
          return;
        }
        send(res, 200, { success: true, errors: [], result: { id } });
      } else {
        send(res, 405, { success: false, errors: [{ code: 0, message: 'method' }] });
      }
    })();
  });
  const origin = await listen(server);
  return Object.assign(fake, {
    baseUrl: `${origin}/client/v4`,
    records,
    ops,
    txt: (n: string) => [...records.values()].filter((r) => r.name === n).map((r) => r.content),
    close: () => closeServer(server),
  });
}

// ---- a fake ACME server ----

export interface FakeAcmeOptions {
  /** Answer the first N signed requests with badNonce. */
  badNonces?: number;
  /** The DNS the CA validates against. */
  dns: ChallengeDns;
  /** Pending polls before an authorization / order settles (exercise polling). */
  pendingPolls?: number;
}

interface Account {
  jwk: { crv: string; kty: string; x: string; y: string };
  url: string;
}

export interface FakeAcme {
  readonly directoryUrl: string;
  readonly log: { path: string; identity: 'jwk' | 'kid'; payload: unknown }[];
  badNonceAnswers: number;
  accountsCreated: number;
  orders: number;
  finalizedCsr: ParsedCsr | null;
  close(): Promise<void>;
}

const b64uJson = (s: string): unknown => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** RFC 7638, written out separately from the code under test. */
function thumbprint(jwk: Account['jwk']): string {
  return createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`).digest('base64url');
}

export async function startFakeAcme(opts: FakeAcmeOptions): Promise<FakeAcme> {
  const caKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const caCert = makeCert({
    spki: createPublicKey(caKey).export({ type: 'spki', format: 'der' }),
    domains: ['fake-ca.invalid'],
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 3650 * 86_400_000),
    issuerKey: caKey,
  });
  const nonces = new Set<string>();
  const accounts = new Map<string, Account>();
  let origin = '';
  let badNoncesLeft = opts.badNonces ?? 0;
  const pending = opts.pendingPolls ?? 1;
  interface Authz { domain: string; status: string; token: string; polls: number; account: Account; error?: string }
  interface Order { identifiers: string[]; authz: string[]; status: string; polls: number; cert?: string }
  const authzs = new Map<string, Authz>();
  const orders = new Map<string, Order>();
  const fake: FakeAcme = {
    directoryUrl: '',
    log: [],
    badNonceAnswers: 0,
    accountsCreated: 0,
    orders: 0,
    finalizedCsr: null,
    close: () => Promise.resolve(),
  };

  const nonce = (): string => {
    const n = randomBytes(12).toString('base64url');
    nonces.add(n);
    return n;
  };
  // Both return true so a route can `return send(...)` in one line.
  const send = (res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): true => {
    res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', 'replay-nonce': nonce(), ...headers });
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return true;
  };
  const problem = (res: ServerResponse, status: number, type: string, detail: string): true => send(res, status, { type: `urn:ietf:params:acme:error:${type}`, detail, status });

  async function validate(a: Authz): Promise<void> {
    // The CA follows the CNAME, like Let's Encrypt, and compares the TXT with its own computation.
    let n = `_acme-challenge.${a.domain}`;
    for (let i = 0; i < 8; i++) {
      const next = await opts.dns.cname(n);
      if (next === null) break;
      n = next;
    }
    const expected = createHash('sha256').update(`${a.token}.${thumbprint(a.account.jwk)}`).digest('base64url');
    const servers = await opts.dns.authoritativeServers('');
    const seen = servers.length === 0 ? [] : await opts.dns.txtAt(servers[0] ?? '', n);
    if (seen.includes(expected)) a.status = 'valid';
    else {
      a.status = 'invalid';
      a.error = `No TXT record found at ${n}`;
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const url = `${origin}${path}`;
      if (path === '/directory') {
        send(res, 200, { newNonce: `${origin}/new-nonce`, newAccount: `${origin}/new-account`, newOrder: `${origin}/new-order`, meta: { termsOfService: `${origin}/tos` } });
        return;
      }
      if (path === '/new-nonce') {
        res.writeHead(req.method === 'HEAD' ? 200 : 204, { 'replay-nonce': nonce(), 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        problem(res, 405, 'malformed', 'POST only');
        return;
      }
      if (req.headers['content-type'] !== 'application/jose+json') {
        problem(res, 415, 'malformed', 'content-type must be application/jose+json');
        return;
      }
      const jws = JSON.parse(await body(req)) as { protected: string; payload: string; signature: string };
      const header = b64uJson(jws.protected) as { alg: string; nonce: string; url: string; jwk?: Account['jwk']; kid?: string };
      if (header.alg !== 'ES256') return problem(res, 400, 'badSignatureAlgorithm', header.alg);
      if (header.url !== url) return problem(res, 401, 'unauthorized', `url ${header.url} != ${url}`);
      if (badNoncesLeft > 0 || !nonces.delete(header.nonce)) {
        if (badNoncesLeft > 0) badNoncesLeft--;
        fake.badNonceAnswers++;
        return problem(res, 400, 'badNonce', 'JWS has an invalid anti-replay nonce');
      }
      let account: Account | undefined;
      let jwk: Account['jwk'];
      if (path === '/new-account') {
        if (header.jwk === undefined || header.kid !== undefined) return problem(res, 400, 'malformed', 'newAccount must use jwk');
        jwk = header.jwk;
      } else {
        if (header.jwk !== undefined || header.kid === undefined) return problem(res, 400, 'malformed', 'must use kid');
        account = accounts.get(header.kid);
        if (account === undefined) return problem(res, 400, 'accountDoesNotExist', header.kid);
        jwk = account.jwk;
      }
      const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
      const sig = Buffer.from(jws.signature, 'base64url');
      if (sig.length !== 64 || !verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key, dsaEncoding: 'ieee-p1363' }, sig)) {
        return problem(res, 400, 'malformed', 'JWS signature does not verify');
      }
      const payload = jws.payload === '' ? null : b64uJson(jws.payload);
      fake.log.push({ path, identity: header.jwk === undefined ? 'kid' : 'jwk', payload });

      if (path === '/new-account') {
        const tp = thumbprint(jwk);
        const existing = [...accounts.values()].find((a) => thumbprint(a.jwk) === tp);
        if (existing !== undefined) return send(res, 200, { status: 'valid' }, { location: existing.url });
        if ((payload as { termsOfServiceAgreed?: boolean }).termsOfServiceAgreed !== true) return problem(res, 400, 'userActionRequired', 'agree to the terms');
        const acct = { jwk, url: `${origin}/acct/${String(accounts.size + 1)}` };
        accounts.set(acct.url, acct);
        fake.accountsCreated++;
        return send(res, 201, { status: 'valid' }, { location: acct.url });
      }
      const acct = account as Account;
      if (path === '/new-order') {
        const ids = (payload as { identifiers: { type: string; value: string }[] }).identifiers.map((i) => i.value);
        const n = String(++fake.orders);
        const authzUrls = ids.map((d, i) => {
          const u = `${origin}/authz/${n}-${String(i)}`;
          authzs.set(u, { domain: d, status: 'pending', token: randomBytes(16).toString('base64url'), polls: 0, account: acct });
          return u;
        });
        orders.set(`${origin}/order/${n}`, { identifiers: ids, authz: authzUrls, status: 'pending', polls: 0 });
        return send(res, 201, { status: 'pending', identifiers: ids.map((value) => ({ type: 'dns', value })), authorizations: authzUrls, finalize: `${origin}/finalize/${n}` }, { location: `${origin}/order/${n}` });
      }
      const authzView = (u: string, a: Authz): unknown => ({
        status: a.status,
        identifier: { type: 'dns', value: a.domain },
        challenges: [
          { type: 'http-01', url: `${u.replace('/authz/', '/chall/')}-http`, token: a.token, status: 'pending' },
          { type: 'dns-01', url: u.replace('/authz/', '/chall/'), token: a.token, status: a.status === 'processing' ? 'processing' : a.status, ...(a.error === undefined ? {} : { error: { type: 'urn:ietf:params:acme:error:dns', detail: a.error } }) },
        ],
      });
      if (path.startsWith('/authz/')) {
        const a = authzs.get(url);
        if (a === undefined) return problem(res, 404, 'malformed', 'no such authz');
        if (a.status === 'processing') {
          const settled = a.polls++ >= pending;
          if (settled) await validate(a);
          const view = authzView(url, a) as object;
          return send(res, 200, settled ? view : { ...view, status: 'pending' }, { 'retry-after': '1' });
        }
        return send(res, 200, authzView(url, a));
      }
      if (path.startsWith('/chall/')) {
        if (path.endsWith('-http')) return problem(res, 400, 'malformed', 'wrong challenge');
        const u = url.replace('/chall/', '/authz/');
        const a = authzs.get(u);
        if (a === undefined) return problem(res, 404, 'malformed', 'no such challenge');
        if (JSON.stringify(payload) !== '{}') return problem(res, 400, 'malformed', 'challenge payload must be {}');
        a.status = 'processing';
        return send(res, 200, { type: 'dns-01', url, token: a.token, status: 'processing' });
      }
      const orderView = (n: string, o: Order): unknown => ({
        status: o.status,
        identifiers: o.identifiers.map((value) => ({ type: 'dns', value })),
        authorizations: o.authz,
        finalize: `${origin}/finalize/${n}`,
        ...(o.status === 'valid' ? { certificate: `${origin}/cert/${n}` } : {}),
      });
      if (path.startsWith('/order/')) {
        const n = path.slice('/order/'.length);
        const o = orders.get(url);
        if (o === undefined) return problem(res, 404, 'malformed', 'no such order');
        if (o.status === 'pending') {
          const states = o.authz.map((u) => authzs.get(u)?.status);
          if (states.every((s) => s === 'valid')) o.status = 'ready';
          else if (states.some((s) => s === 'invalid')) o.status = 'invalid';
        } else if (o.status === 'processing' && o.polls++ >= pending) {
          o.status = 'valid';
        }
        return send(res, 200, orderView(n, o), { 'retry-after': '1' });
      }
      if (path.startsWith('/finalize/')) {
        const n = path.slice('/finalize/'.length);
        const o = orders.get(`${origin}/order/${n}`);
        if (o === undefined) return problem(res, 404, 'malformed', 'no such order');
        if (o.status !== 'ready') return problem(res, 403, 'orderNotReady', o.status);
        const csr = parseCsr(Buffer.from((payload as { csr: string }).csr, 'base64url'));
        if (!csr.signatureValid) return problem(res, 400, 'badCSR', 'CSR signature does not verify');
        if ([...csr.sans].sort().join() !== [...o.identifiers].sort().join()) return problem(res, 400, 'badCSR', 'CSR names do not match the order');
        fake.finalizedCsr = csr;
        o.cert = makeCert({ spki: csr.spki, domains: csr.sans, notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 90 * 86_400_000), issuerKey: caKey });
        o.status = 'processing';
        return send(res, 200, orderView(n, o), { location: `${origin}/order/${n}` });
      }
      if (path.startsWith('/cert/')) {
        const o = orders.get(`${origin}/order/${path.slice('/cert/'.length)}`);
        if (o?.cert === undefined) return problem(res, 404, 'malformed', 'no such certificate');
        if (req.headers.accept !== 'application/pem-certificate-chain') return problem(res, 406, 'malformed', 'accept');
        res.writeHead(200, { 'content-type': 'application/pem-certificate-chain', 'replay-nonce': nonce() });
        res.end(`${o.cert}${caCert}`);
        return;
      }
      problem(res, 404, 'malformed', `no route ${path}`);
    })();
  });
  origin = await listen(server);
  return Object.assign(fake, { directoryUrl: `${origin}/directory`, close: () => closeServer(server) });
}
