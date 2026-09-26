// The setup wizard in the OpenAPI document (PST-REQ-085), from the same zod objects the routes
// validate with. Spread into ROUTES/COMPONENTS by src/openapi/document.ts.
import type { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import * as W from './schemas.js';

export const SETUP_WIZARD_COMPONENTS: Record<string, z.ZodType> = {
  WizardDkimKey: W.WizardDkimKey,
  WizardView: W.WizardView,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];
const MUTATION = {
  '200': { description: 'The wizard after the step.', schema: 'WizardView' },
  '401': err('No session.'),
  '403': err('Not an admin, missing CSRF header, or step_up_required (a TOTP code in the last five minutes).'),
  '409': err('An earlier step is not done yet (step_not_reached), or the step conflicts with existing data.'),
};

const post = (path: string, operationId: string, summary: string, body?: z.ZodType, extra: Record<string, ResponseSpec> = {}): RouteSpec => ({
  method: 'post',
  path: `/api/admin/setup-wizard${path}`,
  operationId,
  tag: 'Admin',
  summary,
  description: 'Admin only, needs a fresh step-up, audited.',
  ...(body === undefined ? {} : { body }),
  headers: CSRF,
  responses: { ...MUTATION, ...(body === undefined ? {} : { '400': err('The request failed validation.') }), ...extra },
});

export const SETUP_WIZARD_ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/admin/setup-wizard',
    operationId: 'getSetupWizard',
    tag: 'Admin',
    summary: 'The setup wizard’s state (PST-REQ-098): resumable, stored server-side.',
    responses: { '200': { description: 'The wizard.', schema: 'WizardView' }, '401': err('No session.'), '403': err('Not an admin.') },
  },
  post('/domain', 'setupWizardDomain', 'Create or confirm the mail domain.', W.DomainRequest),
  post('/dkim', 'setupWizardDkim', 'Generate the domain’s Ed25519 and RSA-2048 DKIM keys (idempotent) and show their TXT records.', undefined, {
    '503': err('POSTROOM_KEK is not set.'),
  }),
  post('/dns', 'setupWizardDns', 'Record that the live DNS check (GET /api/admin/dns) was reviewed.'),
  post('/mailbox', 'setupWizardMailbox', 'Choose the address the test is sent from: the operator’s own, or a new one of theirs.', W.MailboxRequest),
  post('/test', 'setupWizardTest', 'Record the test message sent through POST /api/compose/send; its timeline is GET /api/messages/{id}/delivery.', W.TestRequest, {
    '404': err('Not a sent message of the caller.'),
  }),
  post('/complete', 'setupWizardComplete', 'Finish the wizard (a test must have been sent).'),
];
