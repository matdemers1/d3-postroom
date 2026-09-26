// PST-T-12.1, PST-REQ-160: the Inspect drawer's "Signature and encryption" section — the view
// model reads every status as a sentence, and the drawer renders it (with the S/MIME chain).
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { InspectCrypto, InspectCryptoSigner, MessageInspect } from '../../src/api';
import { INSPECT_SECTIONS, InspectSections } from '../../src/mail/InspectDrawer';
import { cryptoView, decryptionTone, formatFingerprint, humanReason, signatureTone } from '../../src/mail/inspect-crypto';

vi.mock('@d3cloud/ui', () => {
  const box = (tag: string) => (props: { children?: ReactNode; title?: ReactNode }) => createElement(tag, null, props.title ?? null, props.children);
  return { Alert: box('div'), Badge: box('span'), Button: box('button'), Checkbox: box('span'), Cluster: box('div'), Modal: box('div'), ModalClose: box('span'), Skeleton: box('span'), Stack: box('div') };
});

const NOT_ENCRYPTED: InspectCrypto['encryption'] = { status: 'not-encrypted', format: null, reasons: [], recipients: [], cipher: null, integrity: null, openedWithKeyId: null, plaintextBytes: null };

const ALICE: InspectCryptoSigner = {
  keyId: '93B7A2791C7A5AB4',
  fingerprint: '5A715F1777C830019A2D578D93B7A2791C7A5AB4',
  algorithm: 'Ed25519 (EdDSALegacy)',
  hash: 'sha256',
  userIds: ['Alice Test <alice@example.test>'],
  addresses: ['alice@example.test'],
  fromMatches: true,
  createdAt: '2026-09-26T14:04:00.000Z',
  keySource: 'account',
  knownKeyId: 'k1',
  owner: 'contact',
};

const PGP_VERIFIED: InspectCrypto = {
  signature: {
    status: 'verified-known-key',
    format: 'pgp-mime',
    reasons: ['valid Ed25519 signature (sha256) by 5A71…', "the key is one of this account's contact keys"],
    signer: ALICE,
    certificates: [],
    chain: null,
  },
  encryption: NOT_ENCRYPTED,
};
const SMIME: InspectCrypto = {
  signature: {
    status: 'valid-signature-unknown-key',
    format: 'smime',
    reasons: ['signature over the signed attributes verifies'],
    signer: { ...ALICE, keySource: 'message', knownKeyId: null, owner: null, userIds: ['O=Postroom Test, CN=Carol Test'], addresses: ['carol@example.test'] },
    certificates: [
      { subject: 'CN=Carol Test', issuer: 'CN=Intermediate', fingerprint: 'aa', serial: '01', notBefore: '2026-09-26T00:00:00.000Z', notAfter: '2126-09-02T00:00:00.000Z', rfc822Names: ['carol@example.test'], selfSigned: false, signatureVerified: true },
      { subject: 'CN=Intermediate', issuer: 'CN=Root', fingerprint: 'bb', serial: '02', notBefore: '2026-09-26T00:00:00.000Z', notAfter: '2126-09-02T00:00:00.000Z', rfc822Names: [], selfSigned: false, signatureVerified: false },
    ],
    chain: { verified: true, endsAtSelfSigned: false, reason: 'verifies up to the embedded intermediates; the root was not included' },
  },
  encryption: { status: 'decrypted', format: 'smime', reasons: ['decrypted with AES-256-CBC'], recipients: [{ id: 'serial:17', algorithm: 'RSA PKCS#1 v1.5', matchedKeyId: 'k2' }], cipher: 'AES-256-CBC', integrity: null, openedWithKeyId: 'k2', plaintextBytes: 80 },
};

describe('cryptoView', () => {
  it('reads a verified PGP signature from a known key', () => {
    const v = cryptoView(PGP_VERIFIED);
    expect(v.analysed).toBe(true);
    expect(v.signature.tone).toBe('neutral');
    expect(v.signature.headline).toBe('Signed by a key you know — alice@example.test (a contact key).');
    expect(v.signature.facts).toContainEqual({ label: 'Fingerprint', value: '5A71 5F17 77C8 3001 9A2D 578D 93B7 A279 1C7A 5AB4' });
    expect(v.signature.facts).toContainEqual({ label: 'From address', value: 'matches the key' });
    expect(v.encryption.headline).toBe('Not encrypted end to end.');
  });

  it('never presents a key from the message as trusted', () => {
    const v = cryptoView(SMIME);
    expect(v.signature.tone).toBe('attention');
    expect(v.signature.headline).toContain('certificate came only with the message');
    expect(v.signature.facts).toContainEqual({ label: 'Key from', value: 'the message itself — not trusted on its own' });
    expect(v.certificates).toHaveLength(2);
    expect(v.chainNote).toContain('No system trust store');
  });

  it('gives every status a tone and a sentence', () => {
    expect(signatureTone('bad-signature')).toBe('danger');
    expect(signatureTone('unsupported:ecdsa')).toBe('attention');
    expect(signatureTone('not-signed')).toBe('neutral');
    expect(decryptionTone('failed:mdc-mismatch')).toBe('danger');
    expect(decryptionTone('failed:unsupported-seipd-v2')).toBe('attention');
    expect(decryptionTone('no-key')).toBe('attention');
    expect(humanReason('unsupported:signer-key-unavailable')).toBe('signer key unavailable');
    expect(cryptoView({ ...PGP_VERIFIED, signature: { ...PGP_VERIFIED.signature, status: 'bad-signature' } }).signature.headline).toContain('changed after it was signed');
    expect(cryptoView({ ...PGP_VERIFIED, encryption: { ...NOT_ENCRYPTED, status: 'no-key' } }).encryption.headline).toContain('not to any key of yours');
    expect(formatFingerprint('ab:cd:ef:01:23')).toBe('ABCD EF01 23');
  });

  it('says so when the server sent no crypto section', () => {
    expect(cryptoView(undefined).analysed).toBe(false);
  });
});

describe('the drawer section', () => {
  const base = { id: '1', auth: { source: 'none', spf: null, dkim: [], dmarc: null, arc: null, arcOverride: null, dnsbl: null, authenticationResults: [] }, received: [], receipt: null, bucket: null, spam: { signals: [], bayes: null, attachments: [] }, trackers: { html: false, remoteImages: 0, trackersBlocked: 0, linksCleaned: 0 }, mdn: { requested: false, to: [], header: null, options: null, returnPath: null, returnPathMatches: null, sent: false }, headers: [], raw: { url: '/raw', size: 1 } } satisfies MessageInspect;

  const section = (data: MessageInspect): string => {
    const html = renderToStaticMarkup(createElement(InspectSections, { data, learn: false }));
    return /<section[^>]*data-section="Signature and encryption"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
  };

  it('sits right after Authentication', () => {
    expect(INSPECT_SECTIONS.indexOf('Signature and encryption')).toBe(INSPECT_SECTIONS.indexOf('Authentication') + 1);
  });

  it('shows the signature status, signer and decryption status', () => {
    const html = section({ ...base, crypto: SMIME });
    expect(html).toContain('data-status="valid-signature-unknown-key"');
    expect(html).toContain('data-status="decrypted"');
    expect(html).toContain('carol@example.test');
    expect(html).toContain('data-testid="crypto-chain"');
    expect(html).toContain('CN=Intermediate');
  });

  it('renders without a crypto section from an older server', () => {
    expect(section(base)).toContain('were not checked');
  });
});
