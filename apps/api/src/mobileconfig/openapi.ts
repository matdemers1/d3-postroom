// The mobileconfig routes in the OpenAPI document (PST-REQ-085, PST-T-8.6, PST-T-16.16). Spread into
// ROUTES by src/openapi/document.ts. The profile is not JSON; the small JSON answers are described
// inline, since this module publishes no components.
import { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];
const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
const PROFILE = { 'application/x-apple-aspen-config': { schema: { type: 'string', contentEncoding: 'binary' } } };
const PROFILE_HEADERS = {
  'X-Postroom-Mobileconfig-Signed': { description: '1 when signed as CMS SignedData, 0 when served unsigned.', schema: { type: 'string', enum: ['0', '1'] } },
  'X-Postroom-App-Password-Id': { description: 'The id (never the secret) of the app password the profile carries.', schema: { type: 'string', format: 'uuid' } },
};

const server = (security: string[]) => ({
  type: 'object',
  properties: { host: { type: 'string' }, port: { type: 'integer' }, security: { type: 'string', enum: security } },
  required: ['host', 'port', 'security'],
  additionalProperties: false,
});

const SETTINGS = {
  type: 'object',
  properties: {
    address: { type: ['string', 'null'], description: 'The primary address.' },
    username: { type: ['string', 'null'], description: 'What a mail app signs in as: the full address.' },
    imap: server(['tls']),
    smtp: { type: 'array', items: server(['tls', 'starttls']) },
  },
  required: ['address', 'username', 'imap', 'smtp'],
  additionalProperties: false,
};

const LINK = {
  type: 'object',
  properties: {
    url: { type: 'string', format: 'uri', description: 'The one-time profile URL. A secret: show it as a QR code, never store it.' },
    linkId: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Names the link for polling; not the token.' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
  required: ['url', 'linkId', 'expiresAt'],
  additionalProperties: false,
};

const LINK_STATUS = {
  type: 'object',
  properties: {
    redeemed: { type: 'boolean' },
    appPasswordId: { type: ['string', 'null'], format: 'uuid' },
    lastUsedAt: { type: ['string', 'null'], format: 'date-time', description: 'When a mail app first signed in with the minted password.' },
  },
  required: ['redeemed', 'appPasswordId', 'lastUsedAt'],
  additionalProperties: false,
};

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
      '200': { description: 'The .mobileconfig, signed or not.', content: PROFILE, headers: PROFILE_HEADERS },
      '401': err('No session.'),
      '403': err('Missing CSRF header, or step-up required.'),
      '404': err('The account has no primary address.'),
      '503': err('Auth is not configured (no password pepper).'),
    },
  },
  {
    method: 'get',
    path: '/api/mobileconfig/settings',
    operationId: 'getMailSettings',
    tag: 'Mobileconfig',
    summary: 'The IMAP and SMTP servers, ports and username a mail app needs (PST-T-16.16).',
    description: 'The same hosts the Thunderbird autoconfig document advertises: IMAP on 993 (TLS), SMTP on 465 (TLS) and 587 (STARTTLS).',
    responses: { '200': { description: 'The settings.', content: json(SETTINGS) }, '401': err('No session.') },
  },
  {
    method: 'post',
    path: '/api/mobileconfig/links',
    operationId: 'createMobileconfigLink',
    tag: 'Mobileconfig',
    summary: 'A one-time, ten-minute profile URL for an iPhone to open (PST-REQ-139, PST-T-16.16).',
    description:
      'Nothing is minted yet: opening the URL mints the app password and returns the profile, once. The token is an HMAC-signed, 128-bit-random value bound to this account and its expiry. Step-up, audited (by the link id, never the token) and rate-limited.',
    headers: CSRF,
    responses: {
      '201': { description: 'The link.', content: json(LINK) },
      '401': err('No session.'),
      '403': err('Missing CSRF header, or step-up required.'),
      '404': err('The account has no primary address.'),
      '429': err('Too many links in ten minutes.'),
      '503': err('Auth is not configured (no pepper or session secret).'),
    },
  },
  {
    method: 'get',
    path: '/api/mobileconfig/links/{linkId}',
    operationId: 'getMobileconfigLink',
    tag: 'Mobileconfig',
    summary: 'Whether a one-time link was used, and when its app password first signed in.',
    params: z.object({ linkId: z.string().regex(/^[0-9a-f]{64}$/) }),
    responses: { '200': { description: 'The link status.', content: json(LINK_STATUS) }, '401': err('No session.'), '404': err('No such link of yours.') },
  },
  {
    method: 'get',
    path: '/api/mobileconfig/once/{token}',
    operationId: 'redeemMobileconfigLink',
    tag: 'Mobileconfig',
    summary: 'Install the profile from a one-time link. No session: it is the URL an iPhone camera opens.',
    description:
      'Mints one app password scoped for imap+smtp+dav and returns the profile, exactly as POST /api/mobileconfig does — the first time. Every later request, and any expired, forged or malformed token, answers 410 with the same plain-text body. HEAD answers 405 and never spends the link. Audited.',
    params: z.object({ token: z.string() }),
    responses: {
      '200': { description: 'The .mobileconfig, signed or not.', content: PROFILE, headers: PROFILE_HEADERS },
      '410': { description: 'Expired, already used, or not a link.', content: { 'text/plain': { schema: { type: 'string' } } } },
      '429': { description: 'Too many failed attempts from this address.', content: { 'text/plain': { schema: { type: 'string' } } } },
      '503': { description: 'Auth is not configured.', content: { 'text/plain': { schema: { type: 'string' } } } },
    },
  },
];
