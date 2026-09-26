// Calendar objects and vCards are as confidential as mail (PST-ADR-009), so they are encrypted at
// rest the same way a blob is — a fresh DEK per write, wrapped by the KEK — but kept in the row
// rather than the blob store. Why: they are small (capped at DAV_MAX_RESOURCE_BYTES), a PUT must
// commit the bytes, the etag, the sync token and the change-log row in ONE transaction for
// sync-collection to be exact, and content-addressed dedup buys nothing for them. Deleting the row
// deletes the wrapped DEK: crypto-shred, as for a blob. The AAD binds both the DEK and the data to
// the row's id, so ciphertext copied onto another row does not decrypt.
import { decryptBuffer, encryptBuffer, generateDek, unwrapDek, wrapDek, type Kek } from '@postroom/crypto';

export interface Sealed {
  readonly wrappedDek: Buffer;
  readonly kekId: string;
  readonly data: Buffer;
}

const aad = (id: string): string => `dav-resource:${id}`;

export function sealResource(kek: Kek, id: string, plaintext: Uint8Array): Sealed {
  const dek = generateDek();
  try {
    return { wrappedDek: wrapDek(kek, dek, aad(id)), kekId: kek.id, data: encryptBuffer(dek, plaintext, aad(id)) };
  } finally {
    dek.fill(0);
  }
}

export function openResource(kek: Kek, row: { readonly id: string; readonly wrappedDek: Uint8Array; readonly data: Uint8Array }): Buffer {
  const dek = unwrapDek(kek, row.wrappedDek, aad(row.id));
  try {
    return decryptBuffer(dek, row.data, aad(row.id));
  } finally {
    dek.fill(0);
  }
}
