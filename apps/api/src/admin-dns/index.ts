// /api/admin/dns — the admin DNS checker (PST-T-4.8, PST-REQ-099). Mounted by app.ts behind
// requireAdmin. Read-only: it changes nothing, so it needs no step-up and writes no audit row.
//
//   GET /api/admin/dns?domain=d3cloud.io   expected vs live, with pass/fail and the reason, per record
//
// Answers come from Postroom's own validating resolver (DNS_RESOLVER, the compose `unbound`), the
// same one the daemons use — not the browser's, and not a public resolver. A record changed a
// moment ago may still be cached there for its TTL; the UI says so.
import { normalizeDomain, type Db } from '@postroom/db';
import { createResolver, type Resolver } from '@postroom/dns';
import { Router } from 'express';
import { handle } from '../auth/middleware.js';
import type { ApiDeps } from '../deps.js';
import { checkRecords, type CheckRow, type CheckStatus } from './check.js';
import { expectedRecords, hostsFromEnv, isForbiddenName, type DkimKeyView } from './expected.js';
import { DnsQuery } from './schemas.js';

export { checkRecords, checkRecord, parseSrvRdata, type CheckRow, type CheckStatus } from './check.js';
export { expectedRecords, hostsFromEnv, isForbiddenName, dkimPublicKey, type ExpectedRecord } from './expected.js';

const DEFAULT_RESOLVER = '127.0.0.1:53';

interface ResolverChoice {
  resolver: Resolver;
  server: string;
}

const overrides = new WeakMap<ApiDeps, ResolverChoice>();
const built = new WeakMap<ApiDeps, ResolverChoice>();

/** Tests inject a fake resolver for one app (by its deps). */
export function setDnsResolver(deps: ApiDeps, resolver: Resolver, server = 'test resolver'): void {
  overrides.set(deps, { resolver, server });
}

export function resolverFor(deps: ApiDeps): ResolverChoice {
  const injected = overrides.get(deps);
  if (injected !== undefined) return injected;
  let choice = built.get(deps);
  if (choice === undefined) {
    const server = deps.env['DNS_RESOLVER']?.trim() || DEFAULT_RESOLVER;
    choice = { resolver: createResolver({ server, timeoutMs: 2_000, tries: 2 }), server };
    built.set(deps, choice);
  }
  return choice;
}

/** The live DKIM keys of a domain: not retired, newest first. */
export async function dkimKeysOf(db: Db, domainId: string): Promise<DkimKeyView[]> {
  const rows = await db.dkimKey.findMany({
    where: { domainId, retiredAt: null },
    orderBy: [{ activeFrom: 'desc' }, { selector: 'asc' }],
    select: { selector: true, dnsRecord: true },
  });
  return rows;
}

export interface DnsReport {
  domain: string;
  resolver: string;
  checkedAt: string;
  summary: Record<CheckStatus, number>;
  rows: CheckRow[];
}

export class DnsDomainRefused extends Error {
  constructor(readonly code: 'forbidden_domain' | 'unknown_domain' | 'no_domain') {
    super(code);
  }
}

/** Expected vs live for one of our domains. Throws DnsDomainRefused for anything else. */
export async function dnsReport(deps: ApiDeps, requested: string | undefined, now: Date = new Date()): Promise<DnsReport> {
  if (requested !== undefined && isForbiddenName(requested)) throw new DnsDomainRefused('forbidden_domain');
  const domain =
    requested === undefined
      ? ((await deps.db.domain.findFirst({ where: { isPrimary: true } })) ?? (await deps.db.domain.findFirst({ orderBy: { createdAt: 'asc' } })))
      : await deps.db.domain.findUnique({ where: { name: normalizeDomain(requested) } });
  if (domain === null) throw new DnsDomainRefused(requested === undefined ? 'no_domain' : 'unknown_domain');
  if (isForbiddenName(domain.name)) throw new DnsDomainRefused('forbidden_domain');
  const hosts = hostsFromEnv(deps.env, domain.name, deps.config.webOrigin);
  const expected = expectedRecords({ ...hosts, dkim: await dkimKeysOf(deps.db, domain.id) });
  const { resolver, server } = resolverFor(deps);
  const rows = await checkRecords({ resolver, domain: domain.name, helo: hosts.mxHostname }, expected);
  const summary: Record<CheckStatus, number> = { pass: 0, fail: 0, missing: 0, pending: 0, unknown: 0 };
  for (const r of rows) summary[r.status] += 1;
  return { domain: domain.name, resolver: server, checkedAt: now.toISOString(), summary, rows };
}

export function adminDnsRoutes(deps: ApiDeps): Router {
  const router = Router();
  router.get(
    '/',
    handle(async (req, res) => {
      const parsed = DnsQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      try {
        res.setHeader('Cache-Control', 'no-store');
        res.json(await dnsReport(deps, parsed.data.domain, (deps.config.now ?? (() => new Date()))()));
      } catch (error) {
        if (error instanceof DnsDomainRefused) {
          const status = error.code === 'forbidden_domain' ? 400 : 404;
          res.status(status).json({
            error: error.code,
            message:
              error.code === 'forbidden_domain'
                ? 'no-reply subdomains belong to Cloudflare Email Service; Postroom never checks or suggests records there.'
                : 'Not a domain Postroom serves.',
          });
          return;
        }
        throw error;
      }
    }),
  );
  return router;
}
