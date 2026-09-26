// The Keys API's zod schemas (PST-T-12.2, PST-REQ-161). They validate every request, and the OpenAPI
// document is generated from these same objects (PST-REQ-085).
import { z } from 'zod';

const Iso = z.iso.datetime();
const Address = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .regex(/^[^\s@<>]+@[^\s@<>]+$/, 'an address, local@domain');
/** An armored block or PEM text: generous, but bounded. */
const Armored = z.string().min(1).max(512 * 1024);
const Passphrase = z.string().min(1).max(1024);

export const KeyKind = z.enum(['pgp', 'smime']);
export const KeyOwner = z.enum(['own', 'contact']);

export const CryptoKeyView = z.object({
  id: z.uuid(),
  kind: KeyKind,
  owner: KeyOwner.describe('own: the account’s key (signs, decrypts); contact: someone else’s public key (encrypts to, verifies).'),
  address: z.string().describe('The lowercased address the key speaks for.'),
  fingerprint: z.string().describe('OpenPGP: the primary key’s v4 fingerprint, upper-case hex. S/MIME: SHA-256 of the certificate, lower-case hex.'),
  algorithm: z.string(),
  userIds: z.array(z.string()).describe('OpenPGP user IDs, or the certificate subject.'),
  hasPrivate: z.boolean().describe('A private half is stored, sealed under the KEK.'),
  expiresAt: Iso.nullable(),
  revokedAt: Iso.nullable(),
  createdAt: Iso,
});

export const CryptoKeyList = z.object({ keys: z.array(CryptoKeyView) });
export const CryptoKeyCreated = z.object({ key: CryptoKeyView });

export const GenerateKeyBody = z.object({
  address: Address.describe('One of the caller’s own addresses: the user ID’s address.'),
  name: z.string().trim().max(200).regex(/^[^<>\r\n]*$/, 'no angle brackets or line breaks').optional().describe('The user ID’s name; default the account’s display name.'),
});

export const ImportPgpBody = z.object({
  kind: z.literal('pgp'),
  armored: Armored.describe('One ASCII-armored transferable key: a PUBLIC KEY BLOCK (a contact’s key) or a PRIVATE KEY BLOCK (your own).'),
  passphrase: Passphrase.optional().describe('Unlocks a passphrase-protected secret key; it is stored sealed under the KEK instead.'),
  address: Address.optional().describe('Which of the key’s user-ID addresses the row speaks for (default: the first; for your own key, the first that is yours).'),
});

export const ImportSmimeBody = z.object({
  kind: z.literal('smime'),
  certificate: Armored.describe('PEM: the certificate first, then any intermediates.'),
  privateKey: Armored.optional().describe('PEM PKCS#8 (optionally encrypted) private key: makes it your own certificate.'),
  passphrase: Passphrase.optional().describe('For an encrypted PKCS#8 key.'),
  address: Address.optional().describe('Which of the certificate’s rfc822Names the row speaks for.'),
});

export const ImportKeyBody = z.discriminatedUnion('kind', [ImportPgpBody, ImportSmimeBody]);

export const KeyIdParam = z.object({ id: z.uuid() });

export const KeyPublicExport = z.object({
  id: z.uuid(),
  kind: KeyKind,
  fingerprint: z.string(),
  filename: z.string(),
  publicKey: z.string().describe('The armored OpenPGP public key (with any revocation), or the certificate chain in PEM.'),
});

export const ExportSecretBody = z.object({
  passphrase: z.string().min(8).max(1024).optional().describe('Protect the export: OpenPGP S2K (AES-256, iterated+salted SHA-256), or encrypted PKCS#8 (AES-256-CBC). Omit for an unprotected export.'),
});

export const KeySecretExport = z.object({
  id: z.uuid(),
  kind: KeyKind,
  fingerprint: z.string(),
  filename: z.string(),
  protected: z.boolean(),
  secret: z.string().describe('The armored OpenPGP secret key, or the PKCS#8 private key followed by the certificate chain, in PEM.'),
});

export const RevocationReasonName = z.enum(['none', 'superseded', 'compromised', 'retired']);

export const RevokeKeyBody = z.object({
  reason: RevocationReasonName.default('none').describe('For your own OpenPGP key, written into the 0x20 revocation signature (RFC 9580 §5.2.3.31).'),
  text: z.string().max(200).regex(/^[^\r\n]*$/, 'one line').optional(),
});

export type CryptoKeyJson = z.infer<typeof CryptoKeyView>;
