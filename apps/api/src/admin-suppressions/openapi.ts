// The suppression list in the OpenAPI document (PST-REQ-085), from the same zod objects the routes
// validate with. Spread into ROUTES/COMPONENTS by src/openapi/document.ts.
import type { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import * as S from './schemas.js';

export const ADMIN_SUPPRESSIONS_COMPONENTS: Record<string, z.ZodType> = {
  Suppression: S.Suppression,
  SuppressionList: S.SuppressionList,
  SuppressedRefusal: S.SuppressedRefusal,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];
const ADMIN = { '401': err('No session.'), '403': err('Not an admin, missing CSRF header, or (mutations) no fresh step-up.') };

export const ADMIN_SUPPRESSIONS_ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/admin/suppressions',
    operationId: 'listSuppressions',
    tag: 'Admin',
    summary: 'The suppression list, newest first, each with the bounce that caused it (PST-REQ-178).',
    description: 'While an address is listed, every sending path refuses mail to it (PST-REQ-179). Admin only.',
    query: S.SuppressionListQuery,
    responses: { '200': { description: 'The list.', schema: 'SuppressionList' }, '400': err('Invalid query.'), ...ADMIN },
  },
  {
    method: 'post',
    path: '/api/admin/suppressions',
    operationId: 'addSuppression',
    tag: 'Admin',
    summary: 'Add an address to the suppression list by hand (PST-REQ-178).',
    description: 'Needs a fresh step-up. Audited as admin.suppression.add with the address, the actor and the reason (PST-REQ-181).',
    body: S.AddSuppressionBody,
    headers: CSRF,
    responses: { '201': { description: 'Added.', schema: 'Suppression' }, '400': err('Invalid address or reason.'), ...ADMIN, '409': err('Already on the list.') },
  },
  {
    method: 'delete',
    path: '/api/admin/suppressions/{id}',
    operationId: 'removeSuppression',
    tag: 'Admin',
    summary: 'Remove an address from the suppression list, so mail to it is accepted again (PST-REQ-178).',
    description: 'Needs a fresh step-up. Audited as admin.suppression.remove with the address, the actor and the reason (PST-REQ-181).',
    params: S.SuppressionParams,
    body: S.RemoveSuppressionBody,
    headers: CSRF,
    responses: { '204': { description: 'Removed.' }, '400': err('Invalid id or reason.'), ...ADMIN, '404': err('Not on the list.') },
  },
];
