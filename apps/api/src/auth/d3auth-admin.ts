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
  D3AUTH_SAVE_LOCK,
  D3AUTH_SETTING_KEY,
  D3AuthSaveBody,
  D3AuthTestBody,
  ISSUER_MESSAGE,
  normalizeIssuer,
  readStored,
  resolveD3Auth,
  RETYPE_SECRET,
  savedSecret,
  sealClientSecret,
  type StoredD3Auth,
} from './d3auth-settings.js';
import { currentSession, handle, requireStepUp } from './middleware.js';
import { WindowLimiter } from '../mobileconfig/link.js';
import { discoverIssuer, type OidcSettings } from './oidc.js';
import { redirectUriFor, runtimeFor, type AuthRuntime } from './runtime.js';
import { clearSessionCookie } from './sessions.js';

function invalid(res: Response, fields: { path: string; message: string }[]): void {
  res.status(400).json({ error: 'invalid_request', fields });
}

function badRequest(res: Response, error: z.ZodError): void {
  invalid(
    res,
    error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

/** A save refused from inside its transaction: answered with this status and body, never a 500. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body['error']));
  }
}

const toJson = (value: StoredD3Auth): Prisma.InputJsonValue => ({ ...value });
const asStored = (stored: StoredD3Auth | null | 'invalid'): StoredD3Auth | null => (stored === null || stored === 'invalid' ? null : stored);

/** Discovery tests one account may run per window (PST-T-17.6). */
export const TESTS_PER_WINDOW = 10;
export const TEST_WINDOW_MS = 60_000;
/** Every save takes this transaction-scoped lock, so two saves never interleave in the database. */
const SAVE_LOCK = D3AUTH_SAVE_LOCK;

/**
 * Why D3 Auth sessions end with a save: turned off, or a different issuer or client ID than the
 * settings in force — back-channel logout from the old client can no longer reach them, and their
 * admin role came from its roles claim. Null when the client is unchanged.
 */
function endReason(previous: OidcSettings | null, next: OidcSettings | null, enabled: boolean): 'disabled' | 'retargeted' | null {
  if (!enabled) return 'disabled';
  if (previous === null) return next === null ? null : 'retargeted';
  if (next === null || previous.issuer !== next.issuer || previous.clientId !== next.clientId) return 'retargeted';
  return null;
}

/** One save at a time per runtime: the in-process replace always follows the last committed row. */
const saveQueues = new WeakMap<AuthRuntime, Promise<unknown>>();
function serially<T>(rt: AuthRuntime, task: () => Promise<T>): Promise<T> {
  const previous = saveQueues.get(rt) ?? Promise.resolve();
  const run = previous.then(task, task);
  saveQueues.set(
    rt,
    run.catch(() => undefined),
  );
  return run;
}

export function d3authAdminRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();
  const nowMs = (): number => rt.now().getTime();
  const tests = new WindowLimiter(TESTS_PER_WINDOW, TEST_WINDOW_MS, 1_000);

  const view = async (res: Response, extra: { signedOut?: boolean } = {}): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...(await buildD3AuthView(rt.oidc, rt.d3auth, rt.webOrigin, nowMs())), ...extra });
  };

  /**
   * Write the row and its audit in one commit under the save lock — ending the D3 Auth sessions the
   * change strands, in the same commit — then swap the live provider to the committed row, all
   * inside this runtime's save queue. Returns whether the caller's own session was among those ended.
   */
  const save = (
    req: Request,
    action: string,
    decide: (before: StoredD3Auth | null | 'invalid') => { value: StoredD3Auth; after: Record<string, unknown> },
  ): Promise<{ signedOut: boolean }> =>
    serially(rt, async () => {
      const me = currentSession(req);
      const context = getAuditContext(req);
      const actor = { kind: 'account' as const, accountId: me.accountId };
      const redirectUri = redirectUriFor(rt.webOrigin);
      const { saved, ended } = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${SAVE_LOCK}, 0))`;
        const before = await readStored(tx);
        const { value, after } = decide(before);
        await tx.setting.upsert({
          where: { key: D3AUTH_SETTING_KEY },
          create: { key: D3AUTH_SETTING_KEY, value: toJson(value) },
          update: { value: toJson(value) },
        });
        await recordAudit(tx, { actor, action, entityType: 'setting', entityId: D3AUTH_SETTING_KEY, before: auditView(before), after, context });
        const previous = resolveD3Auth(before, rt.kek, rt.envOidc, redirectUri).settings;
        const next = resolveD3Auth(value, rt.kek, rt.envOidc, redirectUri).settings;
        const reason = endReason(previous, next, value.enabled);
        const ids: string[] = [];
        if (reason !== null) {
          // Every D3 Auth session; never a password session.
          const sessions = await tx.session.findMany({ where: { method: 'oidc' }, select: { id: true } });
          ids.push(...sessions.map((row) => row.id));
          await tx.session.deleteMany({ where: { id: { in: ids } } });
          await recordAudit(tx, {
            actor,
            action: 'auth.session.revoke-d3auth',
            entityType: 'setting',
            entityId: D3AUTH_SETTING_KEY,
            after: { count: ids.length, reason, ended: ids },
            context,
          });
        }
        return { saved: value, ended: ids };
      });
      const resolved = resolveD3Auth(saved, rt.kek, rt.envOidc, redirectUri);
      await rt.oidc.ready();
      rt.d3auth = resolved.state;
      rt.oidc.replace(resolved.settings);
      return { signedOut: ended.includes(me.sessionId) };
    });

  /** Answers a Refusal thrown by a save; anything else goes on to the error handler. */
  const answer = async (res: Response, run: () => Promise<{ signedOut: boolean }>): Promise<void> => {
    let outcome: { signedOut: boolean };
    try {
      outcome = await run();
    } catch (error) {
      if (error instanceof Refusal) {
        res.status(error.status).json(error.body);
        return;
      }
      throw error;
    }
    if (outcome.signedOut) clearSessionCookie(res, rt.secure);
    await view(res, outcome);
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
      /**
       * Why the secret must be given, or null when the saved one may be kept: it is kept only for the
       * same issuer and client ID — a sealed secret never follows a retarget, or anyone who can save
       * could point the issuer at their own host and collect it — and only if it still opens.
       */
      const secretNeeded = (stored: StoredD3Auth | null | 'invalid'): string | null => {
        if (clientSecret !== undefined) return null;
        const prior = asStored(stored);
        if (prior !== null && (prior.issuer !== issuer || prior.clientId !== clientId)) return RETYPE_SECRET;
        return savedSecret(kek, stored) === null ? 'Required: no client secret is saved yet.' : null;
      };
      const needed = secretNeeded(await readStored(db));
      if (needed !== null) {
        invalid(res, [{ path: 'clientSecret', message: needed }]);
        return;
      }
      const at = rt.now().toISOString();
      await answer(res, () =>
        save(req, 'auth.d3auth.configure', (before) => {
          // Checked above without the lock; another save that committed in between is a conflict.
          if (secretNeeded(before) !== null) throw new Refusal(409, { error: 'conflict' });
          const prior = asStored(before);
          const sealedSecret = clientSecret === undefined ? prior?.sealedSecret : sealClientSecret(kek, clientSecret);
          if (sealedSecret === undefined) throw new Refusal(409, { error: 'conflict' });
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
        }),
      );
    }),
  );

  // Turned off: a row of { enabled: false }, which wins over the env, and no provider at all.
  router.delete(
    '/',
    requireStepUp(deps),
    handle(async (req, res) => {
      const at = rt.now().toISOString();
      await answer(res, () =>
        save(req, 'auth.d3auth.disable', () => ({
          value: { enabled: false, updatedAt: at },
          after: { enabled: false },
        })),
      );
    }),
  );

  // Is D3 Auth there? Discovery only, against the issuer given or the one in force. Changes nothing,
  // but every successful POST is audited (the mutation guard holds it to that), so it records the try.
  // Limited per account, and the document read is capped (MAX_DISCOVERY_BYTES).
  router.post(
    '/test',
    handle(async (req, res) => {
      const me = currentSession(req);
      if (tests.blocked(me.accountId, nowMs())) {
        res.setHeader('Retry-After', String(TEST_WINDOW_MS / 1000));
        res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds: TEST_WINDOW_MS / 1000 });
        return;
      }
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
      tests.hit(me.accountId, nowMs());
      const result = await discoverIssuer(issuer);
      await recordAudit(db, {
        actor: { kind: 'account', accountId: me.accountId },
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
