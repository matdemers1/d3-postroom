// Sieve scripts over HTTP for the webmail's rules builder (PST-T-9.5, PST-REQ-150). Mounted by
// app.ts at /api/sieve behind a session. The store is ManageSieve's own (@postroom/managesieve/store),
// so a script written here and one written by Thunderbird over ManageSieve obey the same rules: it is
// stored only if it compiles (a refusal names the line and column), one script is active, the active
// one cannot be deleted, and every mutation is audited (PST-REQ-009).
import { getAuditContext, recordAudit } from '@postroom/audit';
import {
  checkScript,
  deleteScript,
  getScript,
  listScripts,
  MAX_SCRIPT_BYTES,
  MAX_SCRIPTS,
  putScript,
  setActive,
  SIEVE_EXTENSIONS,
  SieveStoreError,
  type ScriptSummary as StoredSummary,
  type StoreActor,
} from '@postroom/managesieve/store';
import { Router, type Request, type Response } from 'express';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { ScriptBody, ScriptNameParam, type CheckResultJson, type ScriptDetailJson, type ScriptListJson, type ScriptSummaryJson } from './schemas.js';

function summaryJson(s: StoredSummary): ScriptSummaryJson {
  return { name: s.name, active: s.active, size: s.size, updatedAt: s.updatedAt.toISOString() };
}

function invalid(res: Response, message: string): void {
  res.status(400).json({ error: 'invalid_request', message });
}

/** A store refusal as HTTP: 404 missing, 409 active/exists, 413 too large, 422 does not compile, 400 bad name. */
function refuse(res: Response, err: SieveStoreError): void {
  switch (err.code) {
    case 'nonexistent':
      res.status(404).json({ error: 'not_found', message: err.message });
      return;
    case 'active':
      res.status(409).json({ error: 'script_active', message: err.message });
      return;
    case 'already-exists':
      res.status(409).json({ error: 'script_exists', message: err.message });
      return;
    case 'too-many-scripts':
      res.status(409).json({ error: 'too_many_scripts', message: err.message });
      return;
    case 'too-large':
      res.status(413).json({ error: 'script_too_large', message: err.message });
      return;
    case 'invalid-name':
      res.status(400).json({ error: 'invalid_name', message: err.message });
      return;
    case 'invalid-script':
      res.status(422).json({ error: 'invalid_script', message: err.message, ...(err.problem === null ? {} : { compileError: err.problem }) });
      return;
  }
}

export function sieveRoutes(deps: ApiDeps): Router {
  const { db } = runtimeFor(deps);
  const router = Router();

  const actor = (req: Request): StoreActor => ({ accountId: currentSession(req).accountId, context: getAuditContext(req) });
  const nameOf = (req: Request, res: Response): string | null => {
    const params = ScriptNameParam.safeParse(req.params);
    if (!params.success) {
      invalid(res, 'a script name is required');
      return null;
    }
    return params.data.name;
  };
  const guarded = async (res: Response, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof SieveStoreError) {
        refuse(res, err);
        return;
      }
      throw err;
    }
  };

  router.get(
    '/scripts',
    handle(async (req, res) => {
      const scripts = await listScripts(db, currentSession(req).accountId);
      const body: ScriptListJson = { scripts: scripts.map(summaryJson), extensions: SIEVE_EXTENSIONS.split(' '), maxScripts: MAX_SCRIPTS, maxScriptBytes: MAX_SCRIPT_BYTES };
      res.json(body);
    }),
  );

  router.get(
    '/scripts/:name',
    handle(async (req, res) => {
      const name = nameOf(req, res);
      if (name === null) return;
      const script = await getScript(db, currentSession(req).accountId, name);
      if (script === null) {
        res.status(404).json({ error: 'not_found', message: `there is no script named "${name}"` });
        return;
      }
      const body: ScriptDetailJson = { ...summaryJson(script), content: script.content };
      res.json(body);
    }),
  );

  router.put(
    '/scripts/:name',
    handle(async (req, res) => {
      const name = nameOf(req, res);
      if (name === null) return;
      const body = ScriptBody.safeParse(req.body);
      if (!body.success) {
        invalid(res, 'content must be a string');
        return;
      }
      await guarded(res, async () => {
        const saved = await putScript(db, actor(req), name, body.data.content);
        res.json(summaryJson(saved));
      });
    }),
  );

  router.delete(
    '/scripts/:name',
    handle(async (req, res) => {
      const name = nameOf(req, res);
      if (name === null) return;
      await guarded(res, async () => {
        await deleteScript(db, actor(req), name);
        res.json({ ok: true });
      });
    }),
  );

  router.post(
    '/scripts/:name/activate',
    handle(async (req, res) => {
      const name = nameOf(req, res);
      if (name === null) return;
      await guarded(res, async () => {
        await setActive(db, actor(req), name);
        res.json({ ok: true });
      });
    }),
  );

  router.post(
    '/deactivate',
    handle(async (req, res) => {
      await setActive(db, actor(req), '');
      res.json({ ok: true });
    }),
  );

  // Compile without storing, for the editor (ManageSieve's CHECKSCRIPT). It changes nothing, but it
  // is a POST, and every POST leaves an audit row (the mutation guard's rule), so it records one.
  router.post(
    '/check',
    handle(async (req, res) => {
      const body = ScriptBody.safeParse(req.body);
      if (!body.success) {
        invalid(res, 'content must be a string');
        return;
      }
      const problem = checkScript(body.data.content);
      const me = currentSession(req);
      await recordAudit(db, {
        actor: { kind: 'account', accountId: me.accountId },
        action: 'sieve.script.check',
        entityType: 'sieve_script',
        after: { size: Buffer.byteLength(body.data.content, 'utf8'), valid: problem === null },
        context: getAuditContext(req),
      });
      const out: CheckResultJson = { valid: problem === null, error: problem };
      res.json(out);
    }),
  );

  return router;
}
