// The mobileconfig route in the OpenAPI document (PST-REQ-085, PST-T-8.6). Spread into ROUTES by
// src/openapi/document.ts. The response is not JSON, so there is no component schema to publish.
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];

export const MOBILECONFIG_ROUTES: RouteSpec[] = [
  {
    method: 'post',
    path: '/api/mobileconfig',
    operationId: 'generateMobileconfig',
    tag: 'Mobileconfig',
    summary: 'A configuration profile for Mail, Calendar and Contacts on this account (PST-REQ-139).',
    description:
      'Mints one fresh app password scoped for imap+smtp+dav and embeds it in an Apple configuration profile (Content-Type application/x-apple-aspen-config). Signed as CMS SignedData when a signing certificate is configured (X-Postroom-Mobileconfig-Signed: 1); otherwise served unsigned (: 0) and iOS shows it as Unverified. Step-up and audited.',
    headers: CSRF,
    responses: {
      '200': { description: 'The .mobileconfig, signed or not.', content: { 'application/x-apple-aspen-config': { schema: { type: 'string', contentEncoding: 'binary' } } } },
      '401': err('No session.'),
      '403': err('Missing CSRF header, or step-up required.'),
      '404': err('The account has no primary address.'),
      '503': err('Auth is not configured (no password pepper).'),
    },
  },
];
