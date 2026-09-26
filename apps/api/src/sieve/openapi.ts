// The Sieve routes in the OpenAPI document (PST-T-9.5, PST-REQ-150, PST-REQ-085), generated from the
// same zod objects the routes validate with (schemas.ts). Spread into ROUTES/COMPONENTS by
// src/openapi/document.ts.
import type { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import * as V from './schemas.js';

export const SIEVE_COMPONENTS: Record<string, z.ZodType> = {
  SieveScriptList: V.ScriptList,
  SieveScript: V.ScriptDetail,
  SieveScriptSummary: V.ScriptSummary,
  SieveCheckResult: V.CheckResult,
  SieveScriptRefusal: V.ScriptRefusal,
  SieveOk: V.OkBody,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];
const COMMON = { '400': err('The request failed validation.'), '401': err('No session.') };
const MUTATING = { ...COMMON, '403': err('Missing CSRF header.') };

export const SIEVE_ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/sieve/scripts',
    operationId: 'listSieveScripts',
    tag: 'Sieve',
    summary: "The caller's Sieve scripts (at most one active), the supported extensions and the limits.",
    responses: { '200': { description: 'Scripts, by name.', schema: 'SieveScriptList' }, '401': err('No session.') },
  },
  {
    method: 'get',
    path: '/api/sieve/scripts/{name}',
    operationId: 'getSieveScript',
    tag: 'Sieve',
    summary: 'One script with its source.',
    params: V.ScriptNameParam,
    responses: { '200': { description: 'The script.', schema: 'SieveScript' }, ...COMMON, '404': err('No script by that name.') },
  },
  {
    method: 'put',
    path: '/api/sieve/scripts/{name}',
    operationId: 'putSieveScript',
    tag: 'Sieve',
    summary: 'Create or replace a script; it is stored only if it compiles.',
    description:
      'The same store ManageSieve PUTSCRIPT writes (RFC 5804): the script must compile with every extension Postroom supports; a compile error is refused with its line and column. An active script stays active. Audited. Needs x-postroom-csrf: 1.',
    params: V.ScriptNameParam,
    body: V.ScriptBody,
    headers: CSRF,
    responses: {
      '200': { description: 'Stored.', schema: 'SieveScriptSummary' },
      ...MUTATING,
      '409': { description: 'The account already has the most scripts it may.', schema: 'SieveScriptRefusal' },
      '413': { description: 'The script is too large.', schema: 'SieveScriptRefusal' },
      '422': { description: 'The script does not compile: compileError has the line and column.', schema: 'SieveScriptRefusal' },
    },
  },
  {
    method: 'delete',
    path: '/api/sieve/scripts/{name}',
    operationId: 'deleteSieveScript',
    tag: 'Sieve',
    summary: 'Delete a script. The active script is refused.',
    params: V.ScriptNameParam,
    headers: CSRF,
    responses: { '200': { description: 'Deleted.', schema: 'SieveOk' }, ...MUTATING, '404': err('No script by that name.'), '409': err('The script is active; deactivate it first.') },
  },
  {
    method: 'post',
    path: '/api/sieve/scripts/{name}/activate',
    operationId: 'activateSieveScript',
    tag: 'Sieve',
    summary: 'Make this the one active script; the worker runs it on new mail.',
    params: V.ScriptNameParam,
    headers: CSRF,
    responses: { '200': { description: 'Active.', schema: 'SieveOk' }, ...MUTATING, '404': err('No script by that name.') },
  },
  {
    method: 'post',
    path: '/api/sieve/deactivate',
    operationId: 'deactivateSieveScripts',
    tag: 'Sieve',
    summary: 'Deactivate every script: new mail is sorted by the classifier alone.',
    headers: CSRF,
    responses: { '200': { description: 'No script is active.', schema: 'SieveOk' }, '401': err('No session.'), '403': err('Missing CSRF header.') },
  },
  {
    method: 'post',
    path: '/api/sieve/check',
    operationId: 'checkSieveScript',
    tag: 'Sieve',
    summary: 'Compile a script without storing it (ManageSieve CHECKSCRIPT).',
    description: 'valid is false and error names the 1-based line and column of the first compile error.',
    body: V.ScriptBody,
    headers: CSRF,
    responses: { '200': { description: 'The result.', schema: 'SieveCheckResult' }, ...MUTATING },
  },
];
