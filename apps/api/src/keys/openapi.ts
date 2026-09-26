// The Keys routes in the OpenAPI document (PST-REQ-085), generated from the same zod objects the
// routes validate with (schemas.ts). Spread into ROUTES/COMPONENTS by src/openapi/document.ts.
import type { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import * as K from './schemas.js';

export const KEYS_COMPONENTS: Record<string, z.ZodType> = {
  CryptoKey: K.CryptoKeyView,
  CryptoKeyList: K.CryptoKeyList,
  CryptoKeyCreated: K.CryptoKeyCreated,
  KeyPublicExport: K.KeyPublicExport,
  KeySecretExport: K.KeySecretExport,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];
const COMMON = { '401': err('No session.') };
const MUTATION = { ...COMMON, '400': err('The request failed validation.'), '403': err('Missing CSRF header.') };

export const KEYS_ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/keys',
    operationId: 'listKeys',
    tag: 'Keys',
    summary: 'The caller’s OpenPGP keys and S/MIME certificates, own and contacts’ (PST-REQ-161).',
    responses: { '200': { description: 'Keys.', schema: 'CryptoKeyList' }, ...COMMON },
  },
  {
    method: 'post',
    path: '/api/keys/generate',
    operationId: 'generateKey',
    tag: 'Keys',
    summary: 'Generate an own OpenPGP key: v4 Ed25519 primary + X25519 encryption subkey.',
    description: 'The private half is sealed under the KEK. Audited. Needs x-postroom-csrf: 1.',
    body: K.GenerateKeyBody,
    headers: CSRF,
    responses: { '201': { description: 'The new key.', schema: 'CryptoKeyCreated' }, ...MUTATION, '403': err('Missing CSRF header, or the address is not one of the caller’s.'), '503': err('POSTROOM_KEK is not set.') },
  },
  {
    method: 'post',
    path: '/api/keys/import',
    operationId: 'importKey',
    tag: 'Keys',
    summary: 'Import an armored OpenPGP key or a PEM certificate: public → a contact’s key, with its secret half → your own.',
    description:
      'Exactly one primary key per block; the row’s fingerprint is the primary’s. A passphrase-protected secret key is unlocked with `passphrase` and stored sealed under the KEK. An own key must name one of the caller’s addresses. Audited. Needs x-postroom-csrf: 1.',
    body: K.ImportKeyBody,
    headers: CSRF,
    responses: {
      '201': { description: 'The imported key.', schema: 'CryptoKeyCreated' },
      ...MUTATION,
      '400': err('Unreadable, more than one primary key, a wrong or missing passphrase, or an address that does not match.'),
      '409': err('The key is already stored.'),
      '503': err('POSTROOM_KEK is not set (for an own key).'),
    },
  },
  {
    method: 'get',
    path: '/api/keys/{id}/export',
    operationId: 'exportKey',
    tag: 'Keys',
    summary: 'The public half: the armored OpenPGP key (with any revocation), or the PEM certificate chain.',
    params: K.KeyIdParam,
    responses: { '200': { description: 'The public key.', schema: 'KeyPublicExport' }, ...COMMON, '404': err('Not a key of the caller.') },
  },
  {
    method: 'post',
    path: '/api/keys/{id}/export-secret',
    operationId: 'exportSecretKey',
    tag: 'Keys',
    summary: 'The private half of an own key, optionally passphrase-protected.',
    description: 'Needs a fresh step-up and x-postroom-csrf: 1. Audited.',
    params: K.KeyIdParam,
    body: K.ExportSecretBody,
    headers: CSRF,
    responses: {
      '200': { description: 'The secret key.', schema: 'KeySecretExport' },
      ...MUTATION,
      '403': err('Missing CSRF header, or step-up required.'),
      '404': err('Not a key of the caller.'),
      '409': err('A contact’s key: there is no private half.'),
      '503': err('The private key could not be opened (no KEK).'),
    },
  },
  {
    method: 'post',
    path: '/api/keys/{id}/revoke',
    operationId: 'revokeKey',
    tag: 'Keys',
    summary: 'Revoke a key. An own OpenPGP key also gets a 0x20 revocation signature, stored with its public key.',
    description: 'Nothing the key signed is trusted afterwards, and nothing is encrypted to it. Audited. Needs x-postroom-csrf: 1.',
    params: K.KeyIdParam,
    body: K.RevokeKeyBody,
    headers: CSRF,
    responses: { '200': { description: 'The revoked key.', schema: 'CryptoKeyCreated' }, ...MUTATION, '404': err('Not a key of the caller.'), '409': err('Already revoked.') },
  },
  {
    method: 'delete',
    path: '/api/keys/{id}',
    operationId: 'deleteKey',
    tag: 'Keys',
    summary: 'Remove a contact’s key. Own keys are revoked, never deleted.',
    description: 'Audited. Needs x-postroom-csrf: 1.',
    params: K.KeyIdParam,
    headers: CSRF,
    responses: { '200': { description: 'ok: true.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true } } } } } }, ...COMMON, '403': err('Missing CSRF header.'), '404': err('Not a key of the caller.'), '409': err('An own key.') },
  },
];
