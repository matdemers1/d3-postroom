// The composer's routes in the OpenAPI document (PST-REQ-085), generated from the same zod objects
// the routes validate with (schemas.ts). Spread into ROUTES/COMPONENTS by src/openapi/document.ts.
import type { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import { SNOOZE_COMPONENTS, SNOOZE_ROUTES } from '../mail/snooze.js';
import * as C from './schemas.js';

export const COMPOSE_COMPONENTS: Record<string, z.ZodType> = {
  SendResponse: C.SendResponse,
  Draft: C.Draft,
  DraftList: C.DraftList,
  DraftSaved: C.DraftSaved,
  // PST-T-9.1: held sends, and (from mail/snooze.ts) snoozed conversations.
  PendingSend: C.PendingSend,
  PendingSendList: C.PendingSendList,
  ...SNOOZE_COMPONENTS,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];
const COMMON = { '400': err('The request failed validation.'), '401': err('No session.'), '403': err('Missing CSRF header.'), '503': err('POSTROOM_KEK is not set.') };

export const COMPOSE_ROUTES: RouteSpec[] = [
  {
    method: 'post',
    path: '/api/compose/send',
    operationId: 'sendMessage',
    tag: 'Compose',
    summary: 'Send a message through the submission path, and file it in Sent.',
    description:
      'Builds a strict-CRLF RFC 5322 message (text/plain UTF-8, encoded-words for non-ASCII headers; a forward attaches the original as message/rfc822) and runs it through the same submission path as SMTP on 587/465: From must be one of the caller’s addresses, it is DKIM-signed, the recipient cap is enforced, and it is queued and audited — then filed in Sent in the same transaction and threaded. A draftId is removed from Drafts in that transaction.',
    body: C.SendRequest,
    headers: CSRF,
    responses: {
      '201': { description: 'Queued and filed in Sent.', schema: 'SendResponse' },
      '202': { description: 'Held (undoSeconds > 0 or sendAt): a copy is in Drafts and the worker queues it at releaseAt, unless it is undone first.', schema: 'PendingSend' },
      ...COMMON,
      '403': err('Missing CSRF header, or From is not one of the caller’s addresses.'),
      '404': err('forwardOf is not a message of the caller.'),
      '413': err('The header block is too large.'),
      '429': err('The recipient cap is reached.'),
      '503': err('No DKIM keys for the sender domain (never sent unsigned), or POSTROOM_KEK is not set.'),
    },
  },
  {
    method: 'get',
    path: '/api/compose/pending',
    operationId: 'listPendingSends',
    tag: 'Compose',
    summary: 'The caller’s held sends (undo window and scheduled), soonest first.',
    responses: { '200': { description: 'Held sends.', schema: 'PendingSendList' }, '401': COMMON['401'] },
  },
  {
    method: 'post',
    path: '/api/compose/pending/{id}/undo',
    operationId: 'undoPendingSend',
    tag: 'Compose',
    summary: 'Undo send / cancel a scheduled send: it is never queued, and stays in Drafts.',
    params: C.PendingParams,
    headers: CSRF,
    responses: {
      '200': { description: 'Cancelled; draftId is the copy in Drafts.', schema: 'PendingSend' },
      ...COMMON,
      '404': err('Not a held send of the caller.'),
      '409': err('It has already been sent (or cancelled).'),
    },
  },
  {
    method: 'patch',
    path: '/api/compose/pending/{id}',
    operationId: 'reschedulePendingSend',
    tag: 'Compose',
    summary: 'Move a held send to another time.',
    params: C.PendingParams,
    body: C.PendingPatch,
    headers: CSRF,
    responses: {
      '200': { description: 'Rescheduled.', schema: 'PendingSend' },
      '400': COMMON['400'],
      '401': COMMON['401'],
      '403': COMMON['403'],
      '404': err('Not a held send of the caller.'),
      '409': err('It has already been sent (or cancelled).'),
    },
  },
  ...SNOOZE_ROUTES,
  {
    method: 'get',
    path: '/api/compose/drafts',
    operationId: 'listDrafts',
    tag: 'Compose',
    summary: 'The caller’s drafts, newest first (optionally only those answering one Message-ID).',
    query: C.DraftQuery,
    responses: { '200': { description: 'Drafts.', schema: 'DraftList' }, '400': COMMON['400'], '401': COMMON['401'], '503': COMMON['503'] },
  },
  {
    method: 'post',
    path: '/api/compose/drafts',
    operationId: 'createDraft',
    tag: 'Compose',
    summary: 'Save a new draft in the Drafts mailbox (\\Draft \\Seen).',
    body: C.DraftRequest,
    headers: CSRF,
    responses: { '201': { description: 'Saved.', schema: 'DraftSaved' }, ...COMMON, '403': err('Missing CSRF header, or From is not one of the caller’s addresses.') },
  },
  {
    method: 'get',
    path: '/api/compose/drafts/{id}',
    operationId: 'getDraft',
    tag: 'Compose',
    summary: 'One draft, as the composer edits it.',
    params: C.DraftParams,
    responses: { '200': { description: 'The draft.', schema: 'Draft' }, '400': COMMON['400'], '401': COMMON['401'], '404': err('Not a draft of the caller.'), '503': COMMON['503'] },
  },
  {
    method: 'put',
    path: '/api/compose/drafts/{id}',
    operationId: 'replaceDraft',
    tag: 'Compose',
    summary: 'Replace a draft: a new message is filed and the old one expunged, in one transaction.',
    description: 'The response carries the NEW id; the old one is gone (IMAP clients see it vanish).',
    params: C.DraftParams,
    body: C.DraftRequest,
    headers: CSRF,
    responses: { '200': { description: 'Saved under a new id.', schema: 'DraftSaved' }, ...COMMON, '404': err('Not a draft of the caller.') },
  },
  {
    method: 'delete',
    path: '/api/compose/drafts/{id}',
    operationId: 'deleteDraft',
    tag: 'Compose',
    summary: 'Discard a draft (expunged from Drafts).',
    params: C.DraftParams,
    headers: CSRF,
    responses: { '204': { description: 'Removed.' }, ...COMMON, '404': err('Not a draft of the caller.') },
  },
];
