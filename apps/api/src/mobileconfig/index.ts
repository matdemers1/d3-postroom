// A signed .mobileconfig for Mail + Calendar + Contacts (PST-T-8.6, PST-REQ-139). Mounted by app.ts
// at POST /api/mobileconfig behind a session, step-up and CSRF (destructive enough: it mints a
// fresh app password, exactly like starting an export or an import).
//
//   POST /api/mobileconfig   mints one app password (imap+smtp+dav) and returns the profile
//
// With MOBILECONFIG_SIGNING_CERT_FILE / MOBILECONFIG_SIGNING_KEY_FILE set, the profile is signed as
// CMS SignedData (DER) and iOS shows it as Verified. Unset, the profile is served unsigned — iOS
// still installs it, marked "Unverified" — rather than failing outright.
import { readFileSync } from 'node:fs';
import { getAuditContext, recordAudit } from '@postroom/audit';
import { createAppPassword } from '@postroom/credentials';
import { AddressKind } from '@postroom/db';
import { Router, type Response } from 'express';
import { currentSession, handle, requireStepUp } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { signCms, type SigningKeyPair } from './cms.js';
import { writePlist } from './plist.js';
import { buildProfile } from './profile.js';

const DEFAULT_HOST = 'mx.d3cloud.io';
const DEFAULT_DAV_HOST = 'dav.d3cloud.io';

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

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

export function mobileconfigRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  const imapHost = deps.env['IMAP_HOSTNAME'] ?? DEFAULT_HOST;
  const submissionHost = deps.env['SUBMISSION_HOSTNAME'] ?? DEFAULT_HOST;
  const davHost = deps.env['DAV_HOSTNAME'] ?? DEFAULT_DAV_HOST;
  // Loaded once: the files do not change under a running process, and re-reading them on every
  // request would mean a filesystem hiccup can turn a working signer into a 500.
  const signingKeys = loadSigningKeys(deps.env);

  router.post(
    '/',
    requireStepUp(deps),
    handle(async (req, res) => {
      if (rt.pepper === null) {
        res.status(503).json({ error: 'auth_not_configured' });
        return;
      }
      const me = currentSession(req);
      const address = await db.address.findFirst({
        where: { accountId: me.accountId, kind: AddressKind.primary },
        include: { domain: true },
        orderBy: { createdAt: 'asc' },
      });
      if (address === null) {
        notFound(res);
        return;
      }
      const email = `${address.localPart}@${address.domain.name}`;
      const context = getAuditContext(req);

      const created = await createAppPassword(
        db,
        { kind: 'account', accountId: me.accountId },
        {
          accountId: me.accountId,
          label: `iPhone profile ${rt.now().toISOString().slice(0, 10)}`,
          scopes: ['imap', 'smtp', 'dav'],
        },
        { pepper: rt.pepper, context },
      );

      const principalUrl = `https://${davHost}/dav/principals/${me.accountId}/`;
      const profile = buildProfile({
        accountId: me.accountId,
        displayName: address.localPart,
        email,
        appPassword: created.password,
        imapHost,
        submissionHost,
        davHost,
        principalUrl,
      });
      const plist = Buffer.from(writePlist(profile), 'utf8');
      const signed = signingKeys !== null;
      const body = signed ? signCms(plist, signingKeys, rt.now()) : plist;

      // The profile carries a fresh secret in plaintext; auditing that it was generated (not its
      // contents) is what "every mutation is audited" (PST-REQ-009) asks for here — the app
      // password's own creation is already audited by createAppPassword above.
      await recordAudit(db, {
        actor: { kind: 'account', accountId: me.accountId },
        action: 'mobileconfig.generate',
        entityType: 'account',
        entityId: me.accountId,
        after: { signed, appPasswordId: created.appPassword.id },
        context,
      });

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/x-apple-aspen-config');
      res.setHeader('Content-Disposition', `attachment; filename="${address.localPart}.mobileconfig"`);
      res.setHeader('X-Postroom-Mobileconfig-Signed', signed ? '1' : '0');
      res.status(200).send(body);
    }),
  );

  return router;
}
