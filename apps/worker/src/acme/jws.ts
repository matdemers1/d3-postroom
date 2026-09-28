// JOSE for ACME (RFC 8555 §6.2, RFC 7515, RFC 7638), on node:crypto only (PST-T-0.15).
//
// The account key is ECDSA P-256 and every request is a flattened JWS signed ES256. An ES256
// signature is the raw R||S pair (RFC 7518 §3.4), not the DER SEQUENCE node signs by default —
// hence dsaEncoding 'ieee-p1363'.
import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export const b64u = (data: Uint8Array | string): string => Buffer.from(data).toString('base64url');

export interface EcJwk {
  readonly crv: 'P-256';
  readonly kty: 'EC';
  readonly x: string;
  readonly y: string;
}

export function generateAccountKey(): KeyObject {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
}

/** The public JWK of a P-256 key, with only the members a thumbprint uses. */
export function publicJwk(key: KeyObject): EcJwk {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('the ACME account key must be ECDSA P-256');
  }
  return { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y };
}

/**
 * RFC 7638 thumbprint: SHA-256 over the JSON of the required members only, in lexicographic
 * order, with no whitespace. EC needs crv/kty/x/y; RSA (for the RFC's own test vector) e/kty/n.
 */
export function jwkThumbprint(jwk: EcJwk | Readonly<Record<string, unknown>>): string {
  const members = jwk as Readonly<Record<string, unknown>>;
  const required = members.kty === 'EC' ? ['crv', 'kty', 'x', 'y'] : members.kty === 'RSA' ? ['e', 'kty', 'n'] : null;
  if (required === null) throw new Error(`unsupported JWK kty ${String(members.kty)}`);
  const canonical = `{${required.map((k) => `${JSON.stringify(k)}:${JSON.stringify(members[k])}`).join(',')}}`;
  return b64u(createHash('sha256').update(canonical, 'utf8').digest());
}

/** RFC 8555 §8.1. */
export const keyAuthorization = (token: string, jwk: EcJwk): string => `${token}.${jwkThumbprint(jwk)}`;

/** RFC 8555 §8.4: the TXT record value for a dns-01 challenge. */
export const dns01TxtValue = (keyAuth: string): string => b64u(createHash('sha256').update(keyAuth, 'utf8').digest());

export interface FlattenedJws {
  readonly protected: string;
  readonly payload: string;
  readonly signature: string;
}

export type JwsIdentity = { readonly jwk: EcJwk } | { readonly kid: string };

/**
 * Sign one ACME request. `payload` null is POST-as-GET (§6.3): the payload is the empty string,
 * not an encoded anything.
 */
export function signJws(key: KeyObject, header: { readonly nonce: string; readonly url: string } & JwsIdentity, payload: unknown): FlattenedJws {
  const protectedB64 = b64u(JSON.stringify({ alg: 'ES256', ...header }));
  const payloadB64 = payload === null ? '' : b64u(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(`${protectedB64}.${payloadB64}`, 'ascii'), { key, dsaEncoding: 'ieee-p1363' });
  return { protected: protectedB64, payload: payloadB64, signature: b64u(signature) };
}
