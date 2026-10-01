// A signed .mobileconfig for Mail + Calendar + Contacts (PST-T-8.6, PST-REQ-139), and the "Connect a
// device" screen's API (PST-T-16.16). Mounted by app.ts at /api/mobileconfig behind a session:
//
//   POST /api/mobileconfig             step-up: mints one app password (imap+smtp+dav), returns the profile
//   GET  /api/mobileconfig/settings    the IMAP/SMTP hosts, ports and username a mail app needs
//   POST /api/mobileconfig/links       step-up: a one-time profile URL for an iPhone to open (10 minutes)
//   GET  /api/mobileconfig/links/:id   whether that link was used, and the minted password's lastUsedAt
//                                      and the protocol it was used over
//
// and, separately and WITHOUT a session (mobileconfigOnceRoutes, mounted at /api/mobileconfig/once):
//
//   GET  /api/mobileconfig/once/:token mints the app password and returns the profile, once; 410 after,
//                                      and 410 once the password changes, "sign out everywhere" runs,
//                                      or a newer link is made for the account (PST-T-16.27)
//
// With MOBILECONFIG_SIGNING_CERT_FILE / MOBILECONFIG_SIGNING_KEY_FILE set, the profile is signed as
// CMS SignedData (DER) and iOS shows it as Verified. Unset, the profile is served unsigned — iOS
// still installs it, marked "Unverified" — rather than failing outright.
import { readFileSync } from 'node:fs';
import { getAuditContext, recordAudit, type RequestContext } from '@postroom/audit';
import { createAppPassword } from '@postroom/credentials';
import { AddressKind } from '@postroom/db';
import { Router, type Request, type Response } from 'express';
import { currentSession, handle, requireStepUp } from '../auth/middleware.js';
import { runtimeFor, type AuthRuntime } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { signCms, type SigningKeyPair } from './cms.js';
import { LINK_ID_RE, WindowLimiter, inspectLinkToken, linkKey, mintLinkToken } from './link.js';
import { writePlist } from './plist.js';
import { buildProfile } from './profile.js';

const DEFAULT_HOST = 'mx.d3cloud.io';
const DEFAULT_DAV_HOST = 'dav.d3cloud.io';

/** The audit entity a one-time link is recorded under; its id is the link's nonce hash. */
const LINK_ENTITY = 'mobileconfig_link';
const LINK_CREATE = 'mobileconfig.link.create';
const LINK_REDEEM = 'mobileconfig.link.redeem';
const GENERATE = 'mobileconfig.generate';
/**
 * The account's credential events a link must postdate (PST-T-16.27): written by src/auth (a
 * password change, "sign out everywhere"), read here. A link made before either is dead.
 */
// A new authenticator or a fresh recovery-code set is a credential change too (PST-T-16.26).
const CREDENTIAL_EVENTS = ['auth.password.change', 'auth.session.revoke-others', 'auth.totp.enrol', 'auth.recovery-codes.regenerate'];
/**
 * The row the protocol login check writes when an app password is used (entity `app_password`, id
 * the password's, `after.scope` the protocol it verified for). The newest one names the protocol.
 */
const APP_PASSWORD_ENTITY = 'app_password';
const APP_PASSWORD_USE = 'app_password.use';
/** Links one account may make per window — a loop minting them is a bug or an attack, not a person. */
const LINKS_PER_WINDOW = 10;
/**
 * Malformed or forged tokens one address may send per window before it is told to wait. Only
 * guesses count: a spent, expired or superseded link is a person, not an attacker, and counting it
 * would let anyone behind the same address lock that person out. A token with a good MAC is never
 * refused by the limiter at all.
 */
const REDEEM_FAILURES_PER_WINDOW = 20;
const LIMIT_WINDOW_MS = 10 * 60 * 1000;
/**
 * Opens of one signed link per window (PST-T-16.28). A person opens a link once, maybe twice; a
 * leaked URL replayed in a loop is answered the same 410 past this, with no database work at all.
 * Keyed by the link id, so it never touches anyone else's link.
 */
export const OPENS_PER_LINK = 10;

/**
 * Counted for tests (PST-T-16.28): `prechecks` is the non-locking reads that refused a link before
 * the transaction, `locks` the transactions that took the per-link advisory lock.
 */
export const onceLinkStats = { prechecks: 0, locks: 0 };

const GONE_TEXT = 'This link has expired or has already been used. Make a new one in Postroom under Settings › Security & devices.';

function readPemFile(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Reads the signing cert/key from env once per process; null means "serve unsigned" (never a 500). */
function loadSigningKeys(env: NodeJS.ProcessEnv): SigningKeyPair | null {
  const certFile = env['MOBILECONFIG_SIGNING_CERT_FILE'];
  const keyFile = env['MOBILECONFIG_SIGNING_KEY_FILE'];
  if (certFile === undefined || certFile.trim() === '' || keyFile === undefined || keyFile.trim() === '') return null;
  try {
    const certificatePem = readPemFile(certFile);
    const privateKeyPem = readPemFile(keyFile);
    const chainFile = env['MOBILECONFIG_SIGNING_CHAIN_FILE'];
    const chainPem =
      chainFile === undefined || chainFile.trim() === ''
        ? []
        : (readPemFile(chainFile).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []);
    return { certificatePem, privateKeyPem, chainPem };
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: 'mobileconfig-signing-key-unreadable', error: error instanceof Error ? error.message : String(error) })}\n`);
    return null;
  }
}

/** A protocol an app password can be used over, as the status reports it. */
export type UseProtocol = 'imap' | 'smtp' | 'dav' | 'sieve';
const PROTOCOLS: readonly string[] = ['imap', 'smtp', 'dav', 'sieve'];

function jsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * When an app password was last used and over which protocol: the newest `app_password.use` row's
 * scope, or null when none is recorded (the line then says "Connected at …" without one).
 */
async function useOf(db: AuthRuntime['db'], accountId: string, appPasswordId: string): Promise<{ id: string; lastUsedAt: string | null; protocol: UseProtocol | null } | null> {
  const password = await db.appPassword.findFirst({ where: { id: appPasswordId, accountId }, select: { id: true, lastUsedAt: true } });
  if (password === null) return null;
  if (password.lastUsedAt === null) return { id: password.id, lastUsedAt: null, protocol: null };
  const use = await db.auditEvent.findFirst({
    where: { entityType: APP_PASSWORD_ENTITY, entityId: password.id, action: APP_PASSWORD_USE },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    select: { after: true },
  });
  const scope = jsonObject(use?.after)?.['scope'];
  return {
    id: password.id,
    lastUsedAt: password.lastUsedAt.toISOString(),
    protocol: typeof scope === 'string' && PROTOCOLS.includes(scope) ? (scope as UseProtocol) : null,
  };
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

/**
 * The servers a mail app is pointed at. The same environment variables and defaults the Thunderbird
 * autoconfig and Outlook autodiscover documents read (src/autoconfig), so the copyable settings on
 * the Connect a device screen can never disagree with what autoconfig fills in.
 */
export interface MailHosts {
  imapHost: string;
  submissionHost: string;
  davHost: string;
}

export function mailHostsOf(env: NodeJS.ProcessEnv): MailHosts {
  return {
    imapHost: env['IMAP_HOSTNAME'] ?? DEFAULT_HOST,
    submissionHost: env['SUBMISSION_HOSTNAME'] ?? DEFAULT_HOST,
    davHost: env['DAV_HOSTNAME'] ?? DEFAULT_DAV_HOST,
  };
}

/** GET /api/mobileconfig/settings, as JSON. */
export interface MailSettings {
  address: string | null;
  username: string | null;
  imap: { host: string; port: number; security: 'tls' };
  smtp: { host: string; port: number; security: 'tls' | 'starttls' }[];
}

export function mailSettingsOf(hosts: MailHosts, address: string | null): MailSettings {
  return {
    address,
    username: address,
    imap: { host: hosts.imapHost, port: 993, security: 'tls' },
    smtp: [
      { host: hosts.submissionHost, port: 465, security: 'tls' },
      { host: hosts.submissionHost, port: 587, security: 'starttls' },
    ],
  };
}

interface Issued {
  body: Buffer;
  signed: boolean;
  filename: string;
  appPasswordId: string;
}

/** Everything both the signed-in download and the one-time link need: one profile, one app password. */
class ProfileIssuer {
  private readonly hosts: MailHosts;
  // Loaded once: the files do not change under a running process, and re-reading them on every
  // request would mean a filesystem hiccup can turn a working signer into a 500.
  private readonly signingKeys: SigningKeyPair | null;

  constructor(
    private readonly rt: AuthRuntime,
    env: NodeJS.ProcessEnv,
  ) {
    this.hosts = mailHostsOf(env);
    this.signingKeys = loadSigningKeys(env);
  }

  /** The account's primary address as text, or null when it has none. */
  async primaryAddress(accountId: string): Promise<{ email: string; localPart: string } | null> {
    const address = await this.rt.db.address.findFirst({
      where: { accountId, kind: AddressKind.primary },
      include: { domain: true },
      orderBy: { createdAt: 'asc' },
    });
    if (address === null) return null;
    return { email: `${address.localPart}@${address.domain.name}`, localPart: address.localPart };
  }

  settings(email: string | null): MailSettings {
    return mailSettingsOf(this.hosts, email);
  }

  /**
   * Mints the app password and builds (and signs, when configured) the profile. Null when the account
   * has no primary address. `audit` is spread into the mobileconfig.generate row; `entity` overrides
   * what that row is about (the link, for a redeem).
   */
  async issue(
    accountId: string,
    context: RequestContext,
    audit: { entityType: string; entityId: string; after?: Record<string, unknown> },
  ): Promise<Issued | null> {
    const { rt, hosts, signingKeys } = this;
    if (rt.pepper === null) throw new Error('ProfileIssuer.issue: no pepper');
    const address = await this.primaryAddress(accountId);
    if (address === null) return null;

    const created = await createAppPassword(
      rt.db,
      { kind: 'account', accountId },
      {
        accountId,
        label: `iPhone profile ${rt.now().toISOString().slice(0, 10)}`,
        scopes: ['imap', 'smtp', 'dav'],
      },
      { pepper: rt.pepper, context },
    );

    const principalUrl = `https://${hosts.davHost}/dav/principals/${accountId}/`;
    const profile = buildProfile({
      accountId,
      displayName: address.localPart,
      email: address.email,
      appPassword: created.password,
      imapHost: hosts.imapHost,
      submissionHost: hosts.submissionHost,
      davHost: hosts.davHost,
      principalUrl,
    });
    const plist = Buffer.from(writePlist(profile), 'utf8');
    const signed = signingKeys !== null;
    const body = signed ? signCms(plist, signingKeys, rt.now()) : plist;

    // The profile carries a fresh secret in plaintext; auditing that it was generated (not its
    // contents) is what "every mutation is audited" (PST-REQ-009) asks for here — the app
    // password's own creation is already audited by createAppPassword above. `minted` (not
    // `appPasswordId`, which the audit redactor would blank as password-ish) names the new
    // credential so the link status can find it.
    await recordAudit(rt.db, {
      actor: { kind: 'account', accountId },
      action: GENERATE,
      entityType: audit.entityType,
      entityId: audit.entityId,
      after: { signed, minted: created.appPassword.id, ...audit.after },
      context,
    });

    return { body, signed, filename: `${address.localPart}.mobileconfig`, appPasswordId: created.appPassword.id };
  }
}

const issuers = new WeakMap<ApiDeps, ProfileIssuer>();

function issuerFor(deps: ApiDeps): ProfileIssuer {
  let issuer = issuers.get(deps);
  if (issuer === undefined) {
    issuer = new ProfileIssuer(runtimeFor(deps), deps.env);
    issuers.set(deps, issuer);
  }
  return issuer;
}

function sendProfile(res: Response, issued: Issued): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.setHeader('Content-Disposition', `attachment; filename="${issued.filename}"`);
  res.setHeader('X-Postroom-Mobileconfig-Signed', issued.signed ? '1' : '0');
  // The new credential's id (never its secret), so the screen can watch for its first use.
  res.setHeader('X-Postroom-App-Password-Id', issued.appPasswordId);
  res.status(200).send(issued.body);
}

export function mobileconfigRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const issuer = issuerFor(deps);
  const key = rt.sessionSecret === null ? null : linkKey(rt.sessionSecret);
  const linkLimiter = new WindowLimiter(LINKS_PER_WINDOW, LIMIT_WINDOW_MS);
  const router = Router();

  router.post(
    '/',
    requireStepUp(deps),
    handle(async (req, res) => {
      if (rt.pepper === null) {
        res.status(503).json({ error: 'auth_not_configured' });
        return;
      }
      const me = currentSession(req);
      const issued = await issuer.issue(me.accountId, getAuditContext(req), { entityType: 'account', entityId: me.accountId });
      if (issued === null) {
        notFound(res);
        return;
      }
      sendProfile(res, issued);
    }),
  );

  router.get(
    '/settings',
    handle(async (req, res) => {
      const me = currentSession(req);
      const address = await issuer.primaryAddress(me.accountId);
      res.json(issuer.settings(address?.email ?? null));
    }),
  );

  router.post(
    '/links',
    requireStepUp(deps),
    handle(async (req, res) => {
      if (rt.pepper === null || key === null) {
        res.status(503).json({ error: 'auth_not_configured' });
        return;
      }
      const me = currentSession(req);
      const now = rt.now();
      if (linkLimiter.blocked(me.accountId, now.getTime())) {
        res.setHeader('Retry-After', String(Math.ceil(LIMIT_WINDOW_MS / 1000)));
        res.status(429).json({ error: 'rate_limited' });
        return;
      }
      if ((await issuer.primaryAddress(me.accountId)) === null) {
        notFound(res);
        return;
      }
      linkLimiter.hit(me.accountId, now.getTime());
      const link = mintLinkToken(key, me.accountId, now);
      // The token itself is never audited or logged: the row names the link by its nonce hash.
      await recordAudit(db, {
        actor: { kind: 'account', accountId: me.accountId },
        action: LINK_CREATE,
        entityType: LINK_ENTITY,
        entityId: link.linkId,
        after: { expiresAt: link.expiresAt.toISOString() },
        context: getAuditContext(req),
      });
      res.status(201).json({
        url: new URL(`/api/mobileconfig/once/${link.token}`, rt.webOrigin).toString(),
        linkId: link.linkId,
        expiresAt: link.expiresAt.toISOString(),
      });
    }),
  );

  router.get(
    '/links/:linkId',
    handle(async (req, res) => {
      const me = currentSession(req);
      const linkId = String(req.params['linkId']);
      if (!LINK_ID_RE.test(linkId)) {
        notFound(res);
        return;
      }
      const rows = await db.auditEvent.findMany({
        where: { entityType: LINK_ENTITY, entityId: linkId, actorAccountId: me.accountId, action: { in: [LINK_CREATE, GENERATE] } },
        select: { action: true, after: true },
      });
      // Someone else's link, or no link at all: the same answer.
      if (!rows.some((r) => r.action === LINK_CREATE)) {
        notFound(res);
        return;
      }
      const generated = rows.find((r) => r.action === GENERATE);
      const minted = jsonObject(generated?.after)?.['minted'];
      const use = typeof minted === 'string' ? await useOf(db, me.accountId, minted) : null;
      res.json({
        redeemed: generated !== undefined,
        appPasswordId: use?.id ?? null,
        lastUsedAt: use?.lastUsedAt ?? null,
        protocol: use?.protocol ?? null,
      });
    }),
  );

  return router;
}

/**
 * GET /api/mobileconfig/once/:token — no session, no CSRF (it is a GET a phone's camera opens). Mount
 * it at /api/mobileconfig/once after the /api chain (noStore, auditContext) and BEFORE the
 * session-guarded /api/mobileconfig mount, or requireSession answers 401 first.
 */
export function mobileconfigOnceRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const issuer = issuerFor(deps);
  const key = rt.sessionSecret === null ? null : linkKey(rt.sessionSecret);
  const failures = new WindowLimiter(REDEEM_FAILURES_PER_WINDOW, LIMIT_WINDOW_MS);
  const opens = new WindowLimiter(OPENS_PER_LINK, LIMIT_WINDOW_MS);
  const router = Router();

  /**
   * Whether a link is already spent or superseded, read WITHOUT the lock: the same two questions the
   * locked path asks, so a replayed spent URL is answered from one indexed read and never queues on
   * the advisory lock or holds a pooled connection in a transaction. Only a definite "no" is
   * trusted here; "maybe good" goes on to the locked path, which stays authoritative.
   */
  const refusedWithoutLock = async (link: { linkId: string; accountId: string }): Promise<'spent' | 'superseded' | null> => {
    const spent = await db.auditEvent.findFirst({ where: { entityType: LINK_ENTITY, entityId: link.linkId, action: LINK_REDEEM }, select: { id: true } });
    if (spent !== null) return 'spent';
    const newest = await db.auditEvent.findFirst({
      where: {
        OR: [
          { entityType: LINK_ENTITY, action: LINK_CREATE, actorAccountId: link.accountId },
          { entityType: 'account', entityId: link.accountId, action: { in: CREDENTIAL_EVENTS } },
        ],
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      select: { action: true, entityId: true },
    });
    if (newest === null || newest.action !== LINK_CREATE || newest.entityId !== link.linkId) return 'superseded';
    return null;
  };

  const gone = (req: Request, res: Response, reason: string): void => {
    // Only a guess counts against the address (see REDEEM_FAILURES_PER_WINDOW).
    if (reason === 'malformed' || reason === 'forged') failures.hit(req.ip ?? 'unknown', rt.now().getTime());
    // Logged, not audited: anyone on the internet can send one. Never the token.
    process.stderr.write(`${JSON.stringify({ event: 'mobileconfig-link-refused', reason, ip: req.ip ?? null })}\n`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(410).type('text/plain').send(GONE_TEXT);
  };

  // Express answers HEAD with the GET handler unless told otherwise — and a HEAD (a link preview, a
  // prefetch) must never spend the link.
  router.head('/:token', (_req, res) => {
    res.setHeader('Allow', 'GET');
    res.status(405).end();
  });

  router.get('/:token', (req, res) => {
    const run = async (): Promise<void> => {
      if (rt.pepper === null || key === null) {
        res.status(503).type('text/plain').send('Device setup is not configured on this server.');
        return;
      }
      const now = rt.now();
      // Malformed, forged, expired: one answer, so a caller cannot tell which. The MAC is checked
      // before the limiter, so an address that has been guessing is refused its guesses but never a
      // real link (the HMAC costs next to nothing; guessing 256 bits of it gains nothing).
      const inspected = inspectLinkToken(key, req.params['token'], now);
      if (!inspected.ok) {
        if (inspected.reason !== 'expired' && failures.blocked(req.ip ?? 'unknown', now.getTime())) {
          res.setHeader('Retry-After', String(Math.ceil(LIMIT_WINDOW_MS / 1000)));
          res.status(429).type('text/plain').send('Too many attempts. Wait a few minutes and try again.');
          return;
        }
        gone(req, res, inspected.reason);
        return;
      }
      const { link } = inspected;
      // Past OPENS_PER_LINK opens of this one link: the same 410, no database work (PST-T-16.28).
      if (opens.blocked(link.linkId, now.getTime())) {
        gone(req, res, 'replayed');
        return;
      }
      opens.hit(link.linkId, now.getTime());
      const early = await refusedWithoutLock(link);
      if (early !== null) {
        onceLinkStats.prechecks += 1;
        gone(req, res, early);
        return;
      }
      const account = await db.account.findUnique({ where: { id: link.accountId }, select: { disabledAt: true } });
      if (account === null || account.disabledAt !== null || (await issuer.primaryAddress(link.accountId)) === null) {
        gone(req, res, 'account');
        return;
      }
      const context = getAuditContext(req);
      // Check-and-spend, serialized per link: audit_event has no unique key to lean on, so a
      // transaction-scoped advisory lock keyed by the link id makes "is there a redeem row? if not,
      // write one" atomic. Under READ COMMITTED the SELECT after the lock sees a racing redeem's
      // committed row. The link is spent before the profile is built: if minting then fails, the
      // person makes a new link — it never stays usable twice.
      //
      // A link is good only while its creation is the newest thing that happened to the account's
      // credentials: a later password change, "sign out everywhere" or newer link kills it
      // (PST-T-16.27). One query, ordered by audit time on both sides so no two clocks are compared;
      // no create row at all (it cannot happen, but) is refused too.
      const claimed = await db.$transaction(async (tx): Promise<'ok' | 'spent' | 'superseded'> => {
        onceLinkStats.locks += 1;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'postroom-mobileconfig-link:' + link.linkId}, 0))`;
        const spent = await tx.auditEvent.findFirst({ where: { entityType: LINK_ENTITY, entityId: link.linkId, action: LINK_REDEEM }, select: { id: true } });
        if (spent !== null) return 'spent';
        const newest = await tx.auditEvent.findFirst({
          where: {
            OR: [
              { entityType: LINK_ENTITY, action: LINK_CREATE, actorAccountId: link.accountId },
              { entityType: 'account', entityId: link.accountId, action: { in: CREDENTIAL_EVENTS } },
            ],
          },
          orderBy: [{ at: 'desc' }, { id: 'desc' }],
          select: { action: true, entityId: true },
        });
        if (newest === null || newest.action !== LINK_CREATE || newest.entityId !== link.linkId) return 'superseded';
        await recordAudit(tx, {
          actor: { kind: 'account', accountId: link.accountId },
          action: LINK_REDEEM,
          entityType: LINK_ENTITY,
          entityId: link.linkId,
          context,
        });
        return 'ok';
      });
      if (claimed !== 'ok') {
        gone(req, res, claimed);
        return;
      }
      const issued = await issuer.issue(link.accountId, context, { entityType: LINK_ENTITY, entityId: link.linkId, after: { via: 'link' } });
      if (issued === null) {
        gone(req, res, 'account');
        return;
      }
      sendProfile(res, issued);
    };
    run().catch((error: unknown) => {
      // Answered here rather than by app.ts's error handler, which logs req.path — and the path
      // holds the token.
      process.stderr.write(
        `${JSON.stringify({ event: 'mobileconfig-link-error', path: '/api/mobileconfig/once/:token', message: error instanceof Error ? error.message : String(error) })}\n`,
      );
      if (res.headersSent) {
        // Not next(error): the app's error handler would log the path, token and all.
        res.end();
        return;
      }
      res.status(500).json({ error: 'internal' });
    });
  });

  return router;
}
