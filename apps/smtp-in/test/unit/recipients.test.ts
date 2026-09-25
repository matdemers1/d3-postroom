import { describe, expect, it } from 'vitest';
import { normalizeDomain } from '@postroom/db';
import { resolveRecipient, type AddressRecord, type DomainRecord, type RecipientStore } from '../../src/recipients.js';

const OP = 'acct-operator';
const OTHER = 'acct-other';

function memoryStore(): RecipientStore {
  const domains: DomainRecord[] = [
    { id: 'd1', name: 'd3cloud.io' },
    { id: 'd2', name: normalizeDomain('bücher.example') },
  ];
  const rec = (r: Partial<AddressRecord> & Pick<AddressRecord, 'kind'>): AddressRecord => ({
    accountId: null,
    siteTag: null,
    killedAt: null,
    targets: [],
    ...r,
  });
  const addresses = new Map<string, AddressRecord>([
    ['d1/matt', rec({ kind: 'primary', accountId: OP })],
    ['d1/postmaster', rec({ kind: 'service', accountId: OP })],
    ['d1/team', rec({ kind: 'alias', targets: [OP, OTHER, OP] })],
    ['d1/empty', rec({ kind: 'alias', targets: [] })],
    ['d1/shop.x7k2', rec({ kind: 'masked', accountId: OP, siteTag: 'shop.example' })],
    ['d1/old.a1b2', rec({ kind: 'masked', accountId: OP, siteTag: 'old.example', killedAt: new Date('2026-01-01') })],
    ['d1/a+b', rec({ kind: 'primary', accountId: OTHER })],
    ['d2/info', rec({ kind: 'primary', accountId: OTHER })],
  ]);
  return {
    findDomain: (name) => Promise.resolve(domains.find((d) => d.name === name) ?? null),
    primaryDomain: () => Promise.resolve(domains[0] ?? null),
    findAddress: (domainId, localPart) => Promise.resolve(addresses.get(`${domainId}/${localPart}`) ?? null),
  };
}

const store = memoryStore();

describe('resolveRecipient', () => {
  it('accepts a primary mailbox, case-insensitively in both halves', async () => {
    const r = await resolveRecipient(store, 'Matt@D3Cloud.IO');
    expect(r).toMatchObject({ ok: true, kind: 'mailbox', address: 'matt@d3cloud.io', accountIds: [OP] });
  });

  it('refuses a domain we do not serve with 550 5.7.1, never relaying', async () => {
    for (const addr of ['someone@gmail.com', 'matt@d3cloud.io.evil.test', 'matt@sub.d3cloud.io']) {
      const r = await resolveRecipient(store, addr);
      expect(r).toMatchObject({ ok: false, reason: 'relay-denied', reject: { code: 550, enhanced: '5.7.1' } });
    }
  });

  it('refuses an address literal with 550 5.7.1', async () => {
    const r = await resolveRecipient(store, { kind: 'mailbox', mailbox: { localPart: 'matt', domain: '[127.0.0.1]' } });
    expect(r).toMatchObject({ ok: false, reason: 'address-literal', reject: { code: 550, enhanced: '5.7.1' } });
  });

  it('refuses an unknown local part with 550 5.1.1', async () => {
    const r = await resolveRecipient(store, 'nobody@d3cloud.io');
    expect(r).toMatchObject({ ok: false, reason: 'no-such-user', reject: { code: 550, enhanced: '5.1.1' } });
  });

  it('fans an alias out to its distinct targets', async () => {
    const r = await resolveRecipient(store, 'team@d3cloud.io');
    expect(r).toMatchObject({ ok: true, kind: 'alias', accountIds: [OP, OTHER] });
  });

  it('refuses an alias with no targets', async () => {
    const r = await resolveRecipient(store, 'empty@d3cloud.io');
    expect(r).toMatchObject({ ok: false, reason: 'alias-without-targets', reject: { code: 550 } });
  });

  it('accepts a plus address against its base mailbox, keeping the tag', async () => {
    const r = await resolveRecipient(store, 'matt+Receipts@d3cloud.io');
    expect(r).toMatchObject({ ok: true, kind: 'plus', address: 'matt@d3cloud.io', accountIds: [OP], tag: 'receipts' });
    const service = await resolveRecipient(store, 'postmaster+dmarc@d3cloud.io');
    expect(service).toMatchObject({ ok: true, kind: 'plus', tag: 'dmarc' });
  });

  it('refuses a plus address whose base does not exist, or is not a mailbox', async () => {
    expect(await resolveRecipient(store, 'ghost+x@d3cloud.io')).toMatchObject({ ok: false, reason: 'no-such-user' });
    expect(await resolveRecipient(store, 'team+x@d3cloud.io')).toMatchObject({ ok: false, reason: 'no-such-user' });
    expect(await resolveRecipient(store, 'shop.x7k2+x@d3cloud.io')).toMatchObject({ ok: false, reason: 'no-such-user' });
  });

  it('prefers an exact address containing + over plus addressing', async () => {
    const r = await resolveRecipient(store, 'a+b@d3cloud.io');
    expect(r).toMatchObject({ ok: true, kind: 'mailbox', accountIds: [OTHER] });
  });

  it('accepts a live masked alias and refuses a killed one with 550 5.1.1', async () => {
    expect(await resolveRecipient(store, 'shop.x7k2@d3cloud.io')).toMatchObject({
      ok: true,
      kind: 'masked',
      siteTag: 'shop.example',
    });
    expect(await resolveRecipient(store, 'old.a1b2@d3cloud.io')).toMatchObject({
      ok: false,
      reason: 'killed',
      reject: { code: 550, enhanced: '5.1.1' },
    });
  });

  it('normalises an IDN domain to its ASCII form', async () => {
    const r = await resolveRecipient(store, 'info@BÜCHER.example');
    expect(r).toMatchObject({ ok: true, address: 'info@xn--bcher-kva.example' });
  });

  it('maps bare <Postmaster> to the primary domain', async () => {
    const r = await resolveRecipient(store, { kind: 'postmaster' });
    expect(r).toMatchObject({ ok: true, kind: 'service', address: 'postmaster@d3cloud.io' });
  });

  it('refuses a string that is not an address', async () => {
    expect(await resolveRecipient(store, 'no-at-sign')).toMatchObject({ ok: false, reason: 'no-such-user' });
  });
});
