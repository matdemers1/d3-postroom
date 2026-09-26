// /api/admin/setup-wizard — after first-run setup, the wizard that makes Postroom able to send
// (PST-T-4.8, PST-REQ-098). Mounted by app.ts behind requireAdmin; every mutation also needs a
// fresh step-up (PST-REQ-008) and is audited in the same transaction as its write.
//
//   GET  /                 the wizard's state (resumable: it lives in the `setting` table)
//   POST /domain           { domain }     create (or confirm) the Domain row
//   POST /dkim                            generate the Ed25519 + RSA keys (ensureDkimKeys) and show their TXT
//   POST /dns                             the operator has seen the live check (GET /api/admin/dns)
//   POST /mailbox          { localPart }  the address the test goes from: the operator's, or a new one of theirs
//   POST /test             { outboundId } record the test the web sent through POST /api/compose/send
//   POST /complete                        finish; the timeline stays at GET /api/messages/:id/delivery
//
// The test itself is sent by the web through the composer's API, i.e. the same submission path as
// SMTP (From ownership, DKIM, caps, the outbound queue) — the wizard never has a side door to send.
import { audited, getAuditContext } from '@postroom/audit';
import { AddressKind, DkimAlgorithm, normalizeDomain, type Db } from '@postroom/db';
import { ensureDkimKeys, UnknownDomainError } from '@postroom/submission/dkim';
import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import { isForbiddenName } from '../admin-dns/expected.js';
import { currentSession, handle, requireStepUp } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { DomainRequest, MailboxRequest, TestRequest, WizardView } from './schemas.js';
import { furthest, loadState, reachable, saveState, type Step, type WizardState } from './state.js';

export { loadState, STEPS, SETTING_KEY, type WizardState } from './state.js';

/** Out of scope forever (demers.dev stays on Outlook), and never ours to configure. */
const OUT_OF_SCOPE = new Set(['demers.dev']);

type View = z.infer<typeof WizardView>;

const ALG: Record<DkimAlgorithm, 'ed25519-sha256' | 'rsa-sha256'> = {
  [DkimAlgorithm.ed25519_sha256]: 'ed25519-sha256',
  [DkimAlgorithm.rsa_sha256]: 'rsa-sha256',
};

function parse<S extends z.ZodType>(schema: S, value: unknown, res: Response): z.output<S> | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  res.status(400).json({ error: 'invalid_request', message: result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ') });
  return null;
}

async function viewOf(db: Db, state: WizardState, accountId: string, suggested: string): Promise<View> {
  const domain = state.domain === null ? null : await db.domain.findUnique({ where: { name: state.domain } });
  const keys =
    domain === null
      ? []
      : await db.dkimKey.findMany({
          where: { domainId: domain.id, retiredAt: null },
          orderBy: [{ activeFrom: 'desc' }, { selector: 'asc' }],
          select: { selector: true, algorithm: true, dnsRecord: true },
        });
  const addresses =
    domain === null
      ? []
      : (
          await db.address.findMany({
            where: { accountId, domainId: domain.id, killedAt: null },
            orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
            select: { localPart: true },
          })
        ).map((a) => `${a.localPart}@${domain.name}`);
  return {
    step: state.step,
    completed: state.completedAt !== null,
    completedAt: state.completedAt,
    domain: state.domain,
    suggestedDomain: state.domain ?? suggested,
    dkim: keys.map((k) => ({ selector: k.selector, algorithm: ALG[k.algorithm], dnsName: `${k.selector}._domainkey.${domain?.name ?? ''}`, dnsRecord: k.dnsRecord })),
    dnsAcknowledgedAt: state.dnsAcknowledgedAt,
    mailbox: state.mailbox,
    addresses,
    test: state.test,
  };
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function setupWizardRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();
  const stepUp = requireStepUp(deps);

  const suggestedDomain = async (): Promise<string> => {
    const primary = (await db.domain.findFirst({ where: { isPrimary: true } })) ?? (await db.domain.findFirst({ orderBy: { createdAt: 'asc' } }));
    return primary?.name ?? rt.domain;
  };

  /** One wizard step: check it is reachable, apply it and save the state with its audit row, answer the view. */
  const step = (
    name: Exclude<Step, 'done'>,
    next: Step,
    apply: (req: Request, res: Response, state: WizardState, accountId: string) => Promise<{ state: WizardState; after: Record<string, unknown>; reset?: boolean } | null>,
    action: string = name,
  ) =>
    handle(async (req, res) => {
      const me = currentSession(req);
      const before = await loadState(db);
      if (!reachable(before, name)) {
        res.status(409).json({ error: 'step_not_reached', message: `Finish the ${before.step} step first.` });
        return;
      }
      let applied;
      try {
        applied = await apply(req, res, before, me.accountId);
      } catch (error) {
        if (error instanceof Refusal) {
          res.status(error.status).json({ error: error.code, message: error.message });
          return;
        }
        throw error;
      }
      if (applied === null) return;
      // A reset (a different domain) starts over from the next step; otherwise progress never moves back.
      const state: WizardState = { ...applied.state, step: applied.reset === true ? next : furthest(before.step, next) };
      await audited(
        db,
        { kind: 'account', accountId: me.accountId },
        { action: `setup_wizard.${action}`, entityType: 'setting', context: getAuditContext(req) },
        async (tx) => {
          await saveState(tx, state);
          return { entityId: null, before: { step: before.step }, after: { step: state.step, ...applied.after }, result: null };
        },
      );
      res.json(await viewOf(db, state, me.accountId, await suggestedDomain()));
    });

  router.get(
    '/',
    handle(async (req, res) => {
      const me = currentSession(req);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await viewOf(db, await loadState(db), me.accountId, await suggestedDomain()));
    }),
  );

  router.post(
    '/domain',
    stepUp,
    step('domain', 'dkim', async (req, res, state) => {
      const body = parse(DomainRequest, req.body, res);
      if (body === null) return null;
      const name = normalizeDomain(body.domain);
      if (isForbiddenName(name)) throw new Refusal(400, 'forbidden_domain', 'no-reply subdomains belong to Cloudflare Email Service; Postroom never touches them.');
      if (OUT_OF_SCOPE.has(name)) throw new Refusal(400, 'out_of_scope', `${name} is not served by Postroom.`);
      let created = false;
      const existing = await db.domain.findUnique({ where: { name } });
      if (existing === null) {
        const hasPrimary = (await db.domain.count({ where: { isPrimary: true } })) > 0;
        await db.domain.create({ data: { name, isPrimary: !hasPrimary } });
        created = true;
      }
      // A different domain than before invalidates what was built on the old one.
      const changed = state.domain !== null && state.domain !== name;
      return {
        state: changed ? { ...state, domain: name, dnsAcknowledgedAt: null, mailbox: null, test: null, completedAt: null } : { ...state, domain: name },
        after: { domain: name, created },
        reset: changed,
      };
    }),
  );

  router.post(
    '/dkim',
    stepUp,
    step('dkim', 'dns', async (_req, _res, state) => {
      if (state.domain === null) throw new Refusal(409, 'step_not_reached', 'Choose the domain first.');
      if (rt.kek === null) throw new Refusal(503, 'kek_not_configured', 'POSTROOM_KEK is not set, so DKIM keys cannot be sealed.');
      try {
        const keys = await ensureDkimKeys(db, rt.kek, state.domain, { now: rt.now() });
        return { state, after: { domain: state.domain, selectors: keys.map((k) => k.selector), created: keys.filter((k) => k.created).map((k) => k.selector) } };
      } catch (error) {
        if (error instanceof UnknownDomainError) throw new Refusal(409, 'unknown_domain', 'The domain no longer exists; choose it again.');
        throw error;
      }
    }),
  );

  router.post(
    '/dns',
    stepUp,
    step('dns', 'mailbox', (_req, _res, state) => {
      if (state.domain === null) throw new Refusal(409, 'step_not_reached', 'Choose the domain first.');
      const at = rt.now().toISOString();
      return Promise.resolve({ state: { ...state, dnsAcknowledgedAt: at }, after: { acknowledgedAt: at } });
    }),
  );

  router.post(
    '/mailbox',
    stepUp,
    step('mailbox', 'test', async (req, res, state, accountId) => {
      const body = parse(MailboxRequest, req.body, res);
      if (body === null) return null;
      if (state.domain === null) throw new Refusal(409, 'step_not_reached', 'Choose the domain first.');
      const domain = await db.domain.findUnique({ where: { name: state.domain } });
      if (domain === null) throw new Refusal(409, 'unknown_domain', 'The domain no longer exists; choose it again.');
      const found = await db.address.findUnique({ where: { localPart_domainId: { localPart: body.localPart, domainId: domain.id } } });
      if (found !== null && (found.accountId !== accountId || found.killedAt !== null)) {
        throw new Refusal(409, 'address_taken', `${body.localPart}@${domain.name} already belongs to someone else.`);
      }
      let created = false;
      if (found === null) {
        await db.address.create({ data: { localPart: body.localPart, domainId: domain.id, kind: AddressKind.primary, accountId } });
        created = true;
      }
      const address = `${body.localPart}@${domain.name}`;
      return { state: { ...state, mailbox: address }, after: { address, created } };
    }),
  );

  router.post(
    '/test',
    stepUp,
    step('test', 'test', async (req, res, state, accountId) => {
      const body = parse(TestRequest, req.body, res);
      if (body === null) return null;
      if (state.mailbox === null) throw new Refusal(409, 'step_not_reached', 'Choose the mailbox first.');
      const message = await db.outboundMessage.findFirst({
        where: { id: body.outboundId, accountId },
        select: { id: true, createdAt: true, recipients: { select: { address: true } } },
      });
      // Not the caller's: 404, never 403, so its existence is never leaked.
      if (message === null) throw new Refusal(404, 'not_found', 'Not one of your sent messages.');
      const test = { outboundId: message.id, to: message.recipients.map((r) => r.address), sentAt: message.createdAt.toISOString() };
      return { state: { ...state, test }, after: { outboundId: message.id, to: test.to } };
    }),
  );

  router.post(
    '/complete',
    stepUp,
    step('test', 'done', (_req, _res, state) => {
      if (state.test === null) throw new Refusal(409, 'step_not_reached', 'Send the test message first.');
      const at = rt.now().toISOString();
      return Promise.resolve({ state: { ...state, completedAt: at }, after: { completedAt: at, outboundId: state.test.outboundId } });
    }, 'complete'),
  );

  return router;
}
