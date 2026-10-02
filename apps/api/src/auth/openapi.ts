// Sign in with D3 Auth from the console, and the caller's linked identities, in the OpenAPI document
// (PST-REQ-085, PST-ADR-014). Spread into ROUTES/COMPONENTS by src/openapi/document.ts.
import type { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import { D3AuthSaveBody, D3AuthTestBody, D3AuthTestResult, D3AuthView } from './d3auth-settings.js';
import { IdentityParams, LinkedIdentityList, UnlinkResult } from './identities.js';

export const D3AUTH_COMPONENTS: Record<string, z.ZodType> = {
  D3AuthSettings: D3AuthView,
  D3AuthTestResult,
  LinkedIdentityList,
  IdentityUnlinkResult: UnlinkResult,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];
const ADMIN = { '401': err('No session.'), '403': err('Not an admin, missing CSRF header, or (writes) no fresh step-up.') };
const WRITE =
  'Needs a fresh step-up. The saved row wins over the D3AUTH_* server file, and the live provider is replaced in-process, so /api/auth/state reflects it on the next request with no restart.';

export const D3AUTH_ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/admin/auth/d3auth',
    operationId: 'getD3AuthSettings',
    tag: 'Admin',
    summary: 'Sign in with D3 Auth: where its settings come from, whether D3 Auth answers, and what to register there (PST-REQ-201, PST-REQ-204).',
    description:
      'Never returns the client secret, only secretSet. Carries the exact redirect, back-channel logout and post-logout URIs and a ready-to-paste D3 Auth app manifest built from the server origin. Admin only.',
    responses: { '200': { description: 'The settings in force.', schema: 'D3AuthSettings' }, ...ADMIN },
  },
  {
    method: 'put',
    path: '/api/admin/auth/d3auth',
    operationId: 'saveD3AuthSettings',
    tag: 'Admin',
    summary: 'Save the issuer, client ID and (sealed under the server key) client secret, and use them now (PST-REQ-201).',
    description: `${WRITE} Audited as auth.d3auth.configure, before and after without the secret. The saved secret is kept only for the same issuer and client ID. A changed issuer or client ID ends every D3 Auth session (audited as auth.session.revoke-d3auth); signedOut says whether the caller's own was one, and its cookie is cleared.`,
    body: D3AuthSaveBody,
    headers: CSRF,
    responses: {
      '200': { description: 'Saved and in force.', schema: 'D3AuthSettings' },
      '400': err('Invalid issuer or client ID, or no secret given while none is saved or while the issuer or client ID changes (fields[].path clientSecret).'),
      ...ADMIN,
      '409': err('Another save changed the settings between the check and the commit; reload and try again.'),
      '503': err('The server key (POSTROOM_KEK) is not loaded, so a secret cannot be sealed.'),
    },
  },
  {
    method: 'delete',
    path: '/api/admin/auth/d3auth',
    operationId: 'disableD3Auth',
    tag: 'Admin',
    summary: 'Turn Sign in with D3 Auth off, over the server file as well (PST-REQ-201).',
    description: `${WRITE} Saves { enabled: false }, which wins over the server file with or without the server key, and removes the provider, so the button is disabled. Ends every D3 Auth session (auth.session.revoke-d3auth); signedOut says whether the caller's own was one. Audited as auth.d3auth.disable.`,
    headers: CSRF,
    responses: { '200': { description: 'Turned off.', schema: 'D3AuthSettings' }, ...ADMIN },
  },
  {
    method: 'post',
    path: '/api/admin/auth/d3auth/test',
    operationId: 'testD3AuthIssuer',
    tag: 'Admin',
    summary: 'Fetch an issuer’s discovery document, the one given or the one in force, and say whether it answers.',
    description: 'No secret involved and nothing saved; the attempt is audited as auth.d3auth.test. The discovery document is read up to 256 KiB. Ten a minute per account. Admin only.',
    body: D3AuthTestBody,
    headers: CSRF,
    responses: { '200': { description: 'The outcome; ok is false with error when discovery failed.', schema: 'D3AuthTestResult' }, '400': err('Invalid issuer, or none given and none configured.'), ...ADMIN, '429': err('More than ten tests in a minute.') },
  },
  {
    method: 'get',
    path: '/api/account/identities',
    operationId: 'listLinkedIdentities',
    tag: 'Account',
    summary: 'The D3 Auth identities linked to the signed-in account (PST-REQ-202).',
    description: 'Link one with GET /api/auth/oidc/start?link=1 after a fresh sign-in.',
    responses: { '200': { description: 'Oldest link first.', schema: 'LinkedIdentityList' }, '401': err('No session.') },
  },
  {
    method: 'delete',
    path: '/api/account/identities/{id}',
    operationId: 'unlinkIdentity',
    tag: 'Account',
    summary: 'Unlink one of your D3 Auth identities, ending the sessions that signed in through it (PST-REQ-202).',
    description: 'Needs a fresh step-up. Audited as auth.identity.unlink. Another account’s link answers 404.',
    params: IdentityParams,
    headers: CSRF,
    responses: {
      '200': { description: 'Unlinked; signedOut is true when the caller’s own session came through it.', schema: 'IdentityUnlinkResult' },
      '401': err('No session.'),
      '403': err('Missing CSRF header, or no fresh step-up.'),
      '404': err('Not a link of the caller.'),
      '409': err('last_sign_in_method: the account has no password and this is its only identity.'),
    },
  },
];
