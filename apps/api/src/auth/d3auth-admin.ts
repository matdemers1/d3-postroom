// /api/admin/auth/d3auth — configure, test and turn off Sign in with D3 Auth from the console, with
// no server file edited and no restart (PST-REQ-201, PST-REQ-204, PST-ADR-014). Mounted behind
// requireAdmin; every write behind requireStepUp as well, audited without the secret, and followed
// by an in-process swap of rt.oidc so the very next request signs in against the new settings.
import { getAuditContext, recordAudit } from '@postroom/audit';
import type { Prisma } from '@postroom/db';
import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import type { ApiDeps } from '../deps.js';
import {
  auditView,
  buildD3AuthView,
  D3AUTH_SETTING_KEY,
  D3AuthSaveBody,
  D3AuthTestBody,
  ISSUER_MESSAGE,
  normalizeIssuer,
  readStored,
  resolveD3Auth,
  savedSecret,
  sealClientSecret,
  type StoredD3Auth,
} from './d3auth-settings.js';
import { currentSession, handle, requireStepUp } from './middleware.js';
import { discoverIssuer } from './oidc.js';
import { redirectUriFor, runtimeFor } from './runtime.js';

function invalid(res: Response, fields: { path: string; message: string }[]): void {
  res.status(400).json({ error: 'invalid_request', fields });
}

function badRequest(res: Response, error: z.ZodError): void {
  invalid(
    res,
    error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

const toJson = (value: StoredD3Auth): Prisma.InputJsonValue => ({ ...value });

export function d3authAdminRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();
  const nowMs = (): number => rt.now().getTime();

  const view = async (res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await buildD3AuthView(rt.oidc, rt.d3auth, rt.webOrigin, nowMs()));
  };

  /** Write the row and its audit in one commit, then swap the live provider to match it. */
  const save = async (
    req: Request,
    action: string,
    next: (before: StoredD3Auth | null | 'invalid') => { value: StoredD3Auth; after: Record<string, unknown> },
  ): Promise<void> => {
    const me = currentSession(req);
    const saved = await db.$transaction(async (tx) => {
      const before = await readStored(tx);
      const { value, after } = next(before);
      await tx.setting.upsert({
        where: { key: D3AUTH_SETTING_KEY },
        create: { key: D3AUTH_SETTING_KEY, value: toJson(value) },
        update: { value: toJson(value) },
      });
      await recordAudit(tx, {
        actor: { kind: 'account', accountId: me.accountId },
        action,
        entityType: 'setting',
        entityId: D3AUTH_SETTING_KEY,
        before: auditView(before),
        after,
        context: getAuditContext(req),
      });
      return value;
    });
    const resolved = resolveD3Auth(saved, rt.kek, rt.envOidc, redirectUriFor(rt.webOrigin));
    await rt.oidc.ready();
    rt.d3auth = resolved.state;
    rt.oidc.replace(resolved.settings);
  };

  router.get(
    '/',
    handle(async (_req, res) => {
      await view(res);
    }),
  );

  router.put(
    '/',
    requireStepUp(deps),
    handle(async (req, res) => {
      const kek = rt.kek;
      if (kek === null) {
        res.status(503).json({ error: 'kek_not_configured' });
        return;
      }
      const parsed = D3AuthSaveBody.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, parsed.error);
        return;
      }
      const issuer = normalizeIssuer(parsed.data.issuer);
      if (issuer === null) {
        invalid(res, [{ path: 'issuer', message: `Must be ${ISSUER_MESSAGE}.` }]);
        return;
      }
      const { clientId, clientSecret } = parsed.data;
      // The secret may be left out only when one is saved and still opens under this server's key.
      if (clientSecret === undefined && savedSecret(kek, await readStored(db)) === null) {
        invalid(res, [{ path: 'clientSecret', message: 'Required: no client secret is saved yet.' }]);
        return;
      }
      const at = rt.now().toISOString();
      await save(req, 'auth.d3auth.configure', (before) => {
        const kept = clientSecret === undefined && before !== null && before !== 'invalid' ? before.sealedSecret : undefined;
        const sealedSecret = clientSecret === undefined ? kept : sealClientSecret(kek, clientSecret);
        // Checked above; a row that changed between the check and this commit is refused here.
        if (sealedSecret === undefined) throw new Error('the saved client secret disappeared during the save');
        const prior = before === null || before === 'invalid' ? null : before;
        const changed = [
          ...(prior?.enabled !== true ? ['enabled'] : []),
          ...(prior?.issuer !== issuer ? ['issuer'] : []),
          ...(prior?.clientId !== clientId ? ['clientId'] : []),
          ...(clientSecret !== undefined ? ['clientSecret'] : []),
        ];
        return {
          value: { enabled: true, issuer, clientId, sealedSecret, updatedAt: at },
          // Never the secret, sealed or not: only whether it changed (it is in `changed` when it did).
          after: { enabled: true, issuer, clientId, clientAuth: 'sealed', changed },
        };
      });
      await view(res);
    }),
  );

  // Turned off: a row of { enabled: false }, which wins over the env, and no provider at all.
  router.delete(
    '/',
    requireStepUp(deps),
    handle(async (req, res) => {
      const at = rt.now().toISOString();
      await save(req, 'auth.d3auth.disable', () => ({
        value: { enabled: false, updatedAt: at },
        after: { enabled: false },
      }));
      await view(res);
    }),
  );

  // Is D3 Auth there? Discovery only, against the issuer given or the one in force. Changes nothing,
  // but every successful POST is audited (the mutation guard holds it to that), so it records the try.
  router.post(
    '/test',
    handle(async (req, res) => {
      const parsed = D3AuthTestBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        badRequest(res, parsed.error);
        return;
      }
      let issuer: string | null;
      if (parsed.data.issuer !== undefined) {
        issuer = normalizeIssuer(parsed.data.issuer);
        if (issuer === null) {
          invalid(res, [{ path: 'issuer', message: `Must be ${ISSUER_MESSAGE}.` }]);
          return;
        }
      } else {
        await rt.oidc.ready();
        issuer = rt.oidc.settings?.issuer ?? rt.d3auth.issuer;
        if (issuer === null) {
          invalid(res, [{ path: 'issuer', message: 'No issuer is configured; give one to test.' }]);
          return;
        }
      }
      const result = await discoverIssuer(issuer);
      await recordAudit(db, {
        actor: { kind: 'account', accountId: currentSession(req).accountId },
        action: 'auth.d3auth.test',
        entityType: 'setting',
        entityId: D3AUTH_SETTING_KEY,
        after: { issuer, ok: result.ok, ...(result.error === undefined ? {} : { error: result.error }) },
        context: getAuditContext(req),
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    }),
  );

  return router;
}
