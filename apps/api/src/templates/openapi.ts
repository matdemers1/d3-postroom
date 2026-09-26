// The templates routes in the OpenAPI document (PST-REQ-085), generated from the same zod objects
// the routes validate with (schemas.ts). Spread into ROUTES/COMPONENTS by src/openapi/document.ts.
import type { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import * as T from './schemas.js';

export const TEMPLATES_COMPONENTS: Record<string, z.ZodType> = {
  Template: T.Template,
  TemplateList: T.TemplateList,
  TemplateCreated: T.TemplateCreated,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];
const COMMON = { '401': err('No session.') };

export const TEMPLATES_ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/templates',
    operationId: 'listTemplates',
    tag: 'Templates',
    summary: 'The caller’s compose templates, by shortcut (PST-REQ-144).',
    responses: { '200': { description: 'Templates.', schema: 'TemplateList' }, ...COMMON },
  },
  {
    method: 'get',
    path: '/api/templates/{id}',
    operationId: 'getTemplate',
    tag: 'Templates',
    summary: 'One template.',
    params: T.TemplateIdParam,
    responses: { '200': { description: 'The template.', schema: 'TemplateCreated' }, ...COMMON, '404': err('Not a template of the caller.') },
  },
  {
    method: 'post',
    path: '/api/templates',
    operationId: 'createTemplate',
    tag: 'Templates',
    summary: 'Create a compose template.',
    description: 'Audited. Needs x-postroom-csrf: 1.',
    body: T.CreateTemplateBody,
    headers: CSRF,
    responses: { '201': { description: 'The new template.', schema: 'TemplateCreated' }, ...COMMON, '400': err('The request failed validation.'), '403': err('Missing CSRF header.'), '409': err('The shortcut is already used by another of the caller’s templates.') },
  },
  {
    method: 'put',
    path: '/api/templates/{id}',
    operationId: 'updateTemplate',
    tag: 'Templates',
    summary: 'Replace a template.',
    description: 'Audited. Needs x-postroom-csrf: 1.',
    params: T.TemplateIdParam,
    body: T.UpdateTemplateBody,
    headers: CSRF,
    responses: { '200': { description: 'The template after the change.', schema: 'TemplateCreated' }, ...COMMON, '400': err('The request failed validation.'), '403': err('Missing CSRF header.'), '404': err('Not a template of the caller.'), '409': err('The shortcut is already used by another of the caller’s templates.') },
  },
  {
    method: 'delete',
    path: '/api/templates/{id}',
    operationId: 'deleteTemplate',
    tag: 'Templates',
    summary: 'Delete a template.',
    description: 'Audited. Needs x-postroom-csrf: 1.',
    params: T.TemplateIdParam,
    headers: CSRF,
    responses: { '204': { description: 'Deleted.' }, ...COMMON, '403': err('Missing CSRF header.'), '404': err('Not a template of the caller.') },
  },
];
