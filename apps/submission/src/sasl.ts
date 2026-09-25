// SASL PLAIN (RFC 4616) and LOGIN (draft-murchison-sasl-login) for submission AUTH (RFC 4954).
//
// The session engine runs the exchange (334 challenges, `*` cancels); this turns it into a
// username and password. Nothing here logs or keeps the password.
import type { SaslExchange } from '@postroom/smtp-proto';

export interface SaslCredentials {
  readonly username: string;
  readonly password: string;
}

export const SASL_MECHANISMS = ['PLAIN', 'LOGIN'] as const;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict base64 → UTF-8, or null when the text is not base64 or not valid UTF-8. */
export function decodeBase64Utf8(text: string): string | null {
  if (!BASE64.test(text) || text.length % 4 !== 0) return null;
  const bytes = Buffer.from(text, 'base64');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

export function encodeBase64Utf8(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * RFC 4616 message: [authzid] NUL authcid NUL passwd. An authorization identity different from
 * the authentication identity (acting as someone else) is refused — returns null.
 */
export function parsePlain(message: string): SaslCredentials | null {
  const parts = message.split('\0');
  if (parts.length !== 3) return null;
  const [authzid, username, password] = parts as [string, string, string];
  if (username === '' || password === '') return null;
  if (authzid !== '' && authzid.toLowerCase() !== username.toLowerCase()) return null;
  return { username, password };
}

/** Run the exchange for `mechanism`. Null means the client sent something undecodable. */
export async function readCredentials(
  request: { readonly mechanism: string; readonly initialResponse: string | undefined },
  sasl: SaslExchange,
): Promise<SaslCredentials | null> {
  if (request.mechanism === 'PLAIN') {
    const text = decodeBase64Utf8(request.initialResponse ?? (await sasl.challenge('')));
    return text === null ? null : parsePlain(text);
  }
  if (request.mechanism === 'LOGIN') {
    const username = decodeBase64Utf8(request.initialResponse ?? (await sasl.challenge(encodeBase64Utf8('Username:'))));
    if (username === null || username === '') return null;
    const password = decodeBase64Utf8(await sasl.challenge(encodeBase64Utf8('Password:')));
    if (password === null || password === '') return null;
    return { username, password };
  }
  return null;
}
