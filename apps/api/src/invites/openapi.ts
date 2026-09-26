// The invites routes in the OpenAPI document (PST-REQ-085), generated from the same zod objects the
// routes validate with (schemas.ts). Spread into ROUTES/COMPONENTS by src/openapi/document.ts.
import type { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import * as C from './schemas.js';

export const INVITES_COMPONENTS: Record<string, z.ZodType> = {
  InviteView: C.InviteView,
  InviteRespondResult: C.InviteRespondResult,
  InviteRemoveResult: C.InviteRemoveResult,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];
const COMMON = { '401': err('No session.'), '404': err('No such message of the caller, or it has no calendar part.'), '409': err('The calendar part could not be parsed.'), '503': err('POSTROOM_KEK is not set.') };

export const INVITES_ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/messages/{id}/invite',
    operationId: 'getInvite',
    tag: 'Invites',
    summary: 'The iMIP invitation carried by a message’s text/calendar part.',
    params: C.IdParams,
    responses: { '200': { description: 'The parsed invite.', schema: 'InviteView' }, ...COMMON },
  },
  {
    method: 'post',
    path: '/api/messages/{id}/invite/respond',
    operationId: 'respondToInvite',
    tag: 'Invites',
    summary: 'Accept, tentatively accept, or decline a REQUEST: sends an RFC 5546 REPLY to the organizer and updates the default calendar.',
    params: C.IdParams,
    body: C.RespondBody,
    headers: CSRF,
    responses: {
      '200': { description: 'Sent and saved.', schema: 'InviteRespondResult' },
      ...COMMON,
      '403': err('Missing CSRF header, or none of the caller’s addresses is an attendee.'),
      '409': err('Not a REQUEST, no ORGANIZER, or the calendar object changed at the same time.'),
      '413': err('Header block too large.'),
      '429': err('Recipient cap exceeded.'),
    },
  },
  {
    method: 'post',
    path: '/api/messages/{id}/invite/remove',
    operationId: 'removeInviteFromCalendar',
    tag: 'Invites',
    summary: 'Mark a CANCEL’s event STATUS:CANCELLED in the default calendar.',
    params: C.IdParams,
    headers: CSRF,
    responses: { '200': { description: 'Marked (or nothing to mark).', schema: 'InviteRemoveResult' }, ...COMMON, '403': err('Missing CSRF header.'), '409': err('Not a CANCEL.') },
  },
];
