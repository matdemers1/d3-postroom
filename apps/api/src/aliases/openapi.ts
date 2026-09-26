// The aliases routes in the OpenAPI document (PST-REQ-085), generated from the same zod objects the
// routes validate with (schemas.ts). Spread into ROUTES/COMPONENTS by src/openapi/document.ts.
import type { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import * as A from './schemas.js';

export const ALIASES_COMPONENTS: Record<string, z.ZodType> = {
  Alias: A.AliasView,
  AliasList: A.AliasList,
  AliasCreated: A.AliasCreated,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];
const COMMON = { '401': err('No session.') };

export const ALIASES_ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/aliases',
    operationId: 'listAliases',
    tag: 'Aliases',
    summary: 'The caller\'s masked aliases, newest first (PST-REQ-112).',
    responses: { '200': { description: 'Aliases.', schema: 'AliasList' }, ...COMMON },
  },
  {
    method: 'post',
    path: '/api/aliases',
    operationId: 'createAlias',
    tag: 'Aliases',
    summary: 'Generate a random masked alias tagged with a site (PST-REQ-112).',
    description: 'Audited. Needs x-postroom-csrf: 1.',
    body: A.CreateAliasBody,
    headers: CSRF,
    responses: { '201': { description: 'The new alias.', schema: 'AliasCreated' }, ...COMMON, '400': err('The request failed validation.'), '403': err('Missing CSRF header.'), '503': err('No primary domain is configured.') },
  },
  {
    method: 'post',
    path: '/api/aliases/{id}/kill',
    operationId: 'killAlias',
    tag: 'Aliases',
    summary: 'Kill an alias: RCPT to it is refused with 550 from then on (PST-REQ-112).',
    description: 'Audited. Needs x-postroom-csrf: 1.',
    params: A.AliasIdParam,
    headers: CSRF,
    responses: { '200': { description: 'The alias after the change.', schema: 'AliasCreated' }, ...COMMON, '403': err('Missing CSRF header.'), '404': err('Not an alias of the caller.') },
  },
  {
    method: 'post',
    path: '/api/aliases/{id}/revive',
    operationId: 'reviveAlias',
    tag: 'Aliases',
    summary: 'Revive a killed alias: RCPT to it is accepted again.',
    description: 'Audited. Needs x-postroom-csrf: 1.',
    params: A.AliasIdParam,
    headers: CSRF,
    responses: { '200': { description: 'The alias after the change.', schema: 'AliasCreated' }, ...COMMON, '403': err('Missing CSRF header.'), '404': err('Not an alias of the caller.') },
  },
];
