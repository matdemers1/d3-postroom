// The Inspect drawer's "Signature and encryption" section as plain data (PST-T-12.1, PST-REQ-160),
// kept out of the .tsx so it can be unit-tested in node. Every status the API can return reads as a
// sentence a person can act on; the raw status stays visible beside it as the evidence.
import type { InspectCrypto } from '../api';

export type CryptoTone = 'neutral' | 'attention' | 'danger';

export interface CryptoFact {
  label: string;
  value: string;
}

export interface CryptoPartView {
  /** The raw status the API returned (shown as a badge). */
  status: string;
  tone: CryptoTone;
  headline: string;
  facts: CryptoFact[];
  reasons: string[];
}

export interface CertificateView {
  subject: string;
  issuer: string;
  detail: string;
}

export interface CryptoView {
  /** False when the server sent no crypto section at all (an older API). */
  analysed: boolean;
  signature: CryptoPartView;
  encryption: CryptoPartView;
  certificates: CertificateView[];
  chainNote: string | null;
}

const FORMAT: Record<string, string> = {
  'pgp-mime': 'PGP/MIME (RFC 3156)',
  'pgp-inline': 'Inline PGP',
  'pgp-encrypted': 'OpenPGP, inside the encryption',
  smime: 'S/MIME (RFC 8551)',
  'smime-opaque': 'S/MIME, opaque signed',
};

/** `unsupported:signer-key-unavailable` → "signer key unavailable". */
export function humanReason(status: string): string {
  const i = status.indexOf(':');
  return (i < 0 ? status : status.slice(i + 1)).replace(/-/g, ' ');
}

/** Groups a hex fingerprint in fours, as gpg prints it. */
export function formatFingerprint(fp: string): string {
  return fp.replace(/[^0-9a-fA-F]/g, '').toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
}

export function signatureTone(status: string): CryptoTone {
  if (status === 'verified-known-key' || status === 'not-signed') return 'neutral';
  if (status === 'bad-signature') return 'danger';
  return 'attention';
}

export function decryptionTone(status: string): CryptoTone {
  if (status === 'decrypted' || status === 'not-encrypted') return 'neutral';
  if (status === 'no-key' || status.startsWith('failed:unsupported') || status === 'failed:private-key-unavailable') return 'attention';
  return 'danger';
}

function signatureHeadline(c: InspectCrypto['signature']): string {
  const who = c.signer?.addresses[0] ?? c.signer?.userIds[0] ?? null;
  switch (c.status) {
    case 'verified-known-key':
      return `Signed by a key you know${who === null ? '' : ` — ${who}`}${c.signer?.owner === 'own' ? ' (your own key)' : c.signer?.owner === 'contact' ? ' (a contact key)' : ''}.`;
    case 'valid-signature-unknown-key':
      return `The signature is valid, but the ${c.format === 'smime' || c.format === 'smime-opaque' ? 'certificate' : 'key'} came only with the message: it shows the message was not changed, not who sent it.`;
    case 'bad-signature':
      return 'The signature does not match: the message was changed after it was signed, or the signature is not genuine.';
    case 'not-signed':
      return 'Not signed.';
    default:
      return `The signature could not be checked: ${humanReason(c.status)}.`;
  }
}

function encryptionHeadline(c: InspectCrypto['encryption']): string {
  switch (c.status) {
    case 'decrypted':
      return 'Encrypted to you, and decrypted with your key.';
    case 'no-key':
      return 'Encrypted, but not to any key of yours, so it cannot be read here.';
    case 'not-encrypted':
      return 'Not encrypted end to end.';
    case 'failed:private-key-unavailable':
      return 'Encrypted to one of your keys, but its private half could not be opened.';
    default:
      return `Decryption failed: ${humanReason(c.status)}.`;
  }
}

function signatureFacts(c: InspectCrypto['signature']): CryptoFact[] {
  const facts: CryptoFact[] = [];
  if (c.format !== null) facts.push({ label: 'Format', value: FORMAT[c.format] ?? c.format });
  const s = c.signer;
  if (s === null) return facts;
  if (s.fingerprint !== null) facts.push({ label: c.format === 'smime' || c.format === 'smime-opaque' ? 'Certificate SHA-256' : 'Fingerprint', value: formatFingerprint(s.fingerprint) });
  if (s.algorithm !== null) facts.push({ label: 'Algorithm', value: s.hash === null ? s.algorithm : `${s.algorithm} · ${s.hash}` });
  if (s.userIds.length > 0) facts.push({ label: c.format === 'smime' || c.format === 'smime-opaque' ? 'Subject' : 'User ID', value: s.userIds.join('; ') });
  if (s.addresses.length > 0) facts.push({ label: 'Speaks for', value: s.addresses.join(', ') });
  if (s.fromMatches !== null) facts.push({ label: 'From address', value: s.fromMatches ? 'matches the key' : 'does not match the key' });
  if (s.createdAt !== null) facts.push({ label: 'Signed at', value: s.createdAt });
  facts.push({ label: 'Key from', value: s.keySource === 'account' ? `your keys (${s.owner === 'own' ? 'own' : 'contact'})` : s.keySource === 'message' ? 'the message itself — not trusted on its own' : 'nowhere: not available' });
  return facts;
}

function encryptionFacts(c: InspectCrypto['encryption']): CryptoFact[] {
  const facts: CryptoFact[] = [];
  if (c.format !== null) facts.push({ label: 'Format', value: FORMAT[c.format] ?? c.format });
  for (const r of c.recipients) facts.push({ label: 'Recipient', value: `${r.id}${r.algorithm === null ? '' : ` · ${r.algorithm}`}${r.matchedKeyId === null ? '' : ' · one of your keys'}` });
  if (c.cipher !== null) facts.push({ label: 'Cipher', value: c.integrity === null ? c.cipher : `${c.cipher} · ${c.integrity}` });
  if (c.plaintextBytes !== null) facts.push({ label: 'Decrypted size', value: `${String(c.plaintextBytes)} bytes` });
  return facts;
}

const NOT_ANALYSED: CryptoView = {
  analysed: false,
  signature: { status: 'not-analysed', tone: 'neutral', headline: 'Signatures were not checked for this message.', facts: [], reasons: [] },
  encryption: { status: 'not-analysed', tone: 'neutral', headline: 'Encryption was not checked for this message.', facts: [], reasons: [] },
  certificates: [],
  chainNote: null,
};

export function cryptoView(crypto: InspectCrypto | undefined): CryptoView {
  if (crypto === undefined) return NOT_ANALYSED;
  const sig = crypto.signature;
  const enc = crypto.encryption;
  return {
    analysed: true,
    signature: { status: sig.status, tone: signatureTone(sig.status), headline: signatureHeadline(sig), facts: signatureFacts(sig), reasons: sig.reasons },
    encryption: { status: enc.status, tone: decryptionTone(enc.status), headline: encryptionHeadline(enc), facts: encryptionFacts(enc), reasons: enc.reasons },
    certificates: sig.certificates.map((c) => ({
      subject: c.subject,
      issuer: c.issuer,
      detail: [
        c.selfSigned ? 'self-signed' : null,
        c.signatureVerified ? 'signature verifies' : 'signature not verified',
        c.rfc822Names.length > 0 ? c.rfc822Names.join(', ') : null,
        `valid ${c.notBefore.slice(0, 10)} to ${c.notAfter.slice(0, 10)}`,
      ]
        .filter((x): x is string => x !== null)
        .join(' · '),
    })),
    chainNote: sig.chain === null ? null : `${sig.chain.verified ? 'Chain verifies' : 'Chain does not verify'}: ${sig.chain.reason}. No system trust store was consulted.`,
  };
}
