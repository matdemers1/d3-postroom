// PST-REQ-133 — iOS Contacts' request sequence, replayed with vCard 3.0 bodies: well-known →
// principal → addressbook-home-set → home Depth 1 → sync-collection → PUT (If-None-Match: *) →
// addressbook-multiget → edit (If-Match) → DELETE → incremental sync shows the tombstone. Plus an
// addressbook-query, the UID rule and a card that is not a vCard.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NS } from '@postroom/dav-proto';
import { IOS_PROPFIND_ADDRESSBOOK_HOME, IOS_PROPFIND_CARDDAV_PRINCIPAL, IOS_PROPFIND_PRINCIPAL, iosAddressbookMultiget, iosCard, iosSyncCollection } from '../fixtures.js';
import { client, makeAccount, prop, propHrefs, responses, startHarness, type Account, type Client, type Harness } from './harness.js';

let h: Harness;
let account: Account;
let phone: Client;
let web: Client;

beforeAll(async () => {
  h = await startHarness('pst_dav_ios_card');
  account = await makeAccount(h);
  phone = client(h.base, account);
  web = client(h.base, account, { 'User-Agent': 'DAVx5/4.4 (Android)' });
});
afterAll(async () => {
  await h.close();
});

const vcard = { 'Content-Type': 'text/vcard; charset=utf-8' };

describe('iOS Contacts, end to end', () => {
  const uid = randomUUID().toUpperCase();
  let book = '';
  let cardHref = '';
  let token0 = '';

  it('discovers the address book home and the default Contacts book', async () => {
    const wk = await phone.request('PROPFIND', '/.well-known/carddav', { body: IOS_PROPFIND_PRINCIPAL, headers: { Depth: '0' }, auth: false });
    expect(wk.status).toBe(301);
    expect(wk.headers.get('location')).toBe('/dav/');

    const root = responses((await phone.request('PROPFIND', '/dav/', { body: IOS_PROPFIND_PRINCIPAL, headers: { Depth: '0' } })).xml);
    const principal = propHrefs(root.byHref.get('/dav/'), NS.DAV, 'current-user-principal')[0] ?? '';
    const p = responses((await phone.request('PROPFIND', principal, { body: IOS_PROPFIND_CARDDAV_PRINCIPAL, headers: { Depth: '0' } })).xml);
    const home = propHrefs(p.byHref.get(principal), NS.CARDDAV, 'addressbook-home-set')[0] ?? '';
    expect(home).toBe(`/dav/addressbooks/${account.id}/`);

    const r = await phone.request('PROPFIND', home, { body: IOS_PROPFIND_ADDRESSBOOK_HOME, headers: { Depth: '1' } });
    const { list } = responses(r.xml);
    expect(list.map((v) => v.href)).toEqual([home, `${home}contacts/`]);
    const contacts = list[1];
    book = contacts?.href ?? '';
    expect(contacts?.props.get(`{${NS.DAV}}resourcetype`)?.el.children.map((c) => (typeof c === 'string' ? c : c.local))).toEqual(['collection', 'addressbook']);
    expect(prop(contacts, NS.DAV, 'displayname')).toBe('Contacts');
    expect(prop(contacts, NS.CARDDAV, 'max-resource-size')).toBe(String(128 * 1024));
    expect(prop(contacts, NS.CS, 'getctag')).toBeDefined();
    expect(JSON.stringify(contacts?.props.get(`{${NS.DAV}}supported-report-set`)?.el)).toContain('addressbook-multiget');
    expect(contacts?.props.get(`{${NS.CS}}me-card`)?.status).toBe(404);
  });

  it('creates, reads, edits and deletes a vCard 3.0 contact, and each shows up in the other side’s sync', async () => {
    token0 = responses((await phone.request('REPORT', book, { body: iosSyncCollection(''), headers: { Depth: '1' } })).xml).syncToken ?? '';
    cardHref = `${book}${uid}.vcf`;
    const created = await phone.request('PUT', cardHref, { body: iosCard(uid, 'Ada', 'Lovelace', 'ada@example.com'), headers: { ...vcard, 'If-None-Match': '*' } });
    expect(created.status).toBe(201);
    const etag1 = created.headers.get('etag') ?? '';

    const s1 = responses((await web.request('REPORT', book, { body: iosSyncCollection(token0), headers: { Depth: '1' } })).xml);
    expect(s1.list.map((v) => [v.href, prop(v, NS.DAV, 'getetag'), prop(v, NS.DAV, 'getcontenttype')])).toEqual([[cardHref, etag1, 'text/vcard; charset=utf-8']]);

    const mg = responses((await web.request('REPORT', book, { body: iosAddressbookMultiget([cardHref, `${book}missing.vcf`]), headers: { Depth: '1' } })).xml);
    expect(prop(mg.byHref.get(cardHref), NS.CARDDAV, 'address-data')).toBe(iosCard(uid, 'Ada', 'Lovelace', 'ada@example.com'));
    expect(mg.byHref.get(`${book}missing.vcf`)?.status).toBe(404);

    // Edited on the other device; the phone's stale write 412s; the phone's sync sees the edit.
    const edit = await web.request('PUT', cardHref, { body: iosCard(uid, 'Ada', 'King', 'ada@example.com'), headers: { ...vcard, 'If-Match': etag1 } });
    expect(edit.status).toBe(204);
    const etag2 = edit.headers.get('etag') ?? '';
    expect((await phone.request('PUT', cardHref, { body: iosCard(uid, 'Ada', 'Byron', 'ada@example.com'), headers: { ...vcard, 'If-Match': etag1 } })).status).toBe(412);
    const s2 = responses((await phone.request('REPORT', book, { body: iosSyncCollection(s1.syncToken ?? ''), headers: { Depth: '1' } })).xml);
    expect(s2.list.map((v) => [v.href, prop(v, NS.DAV, 'getetag')])).toEqual([[cardHref, etag2]]);
    expect((await phone.request('GET', cardHref)).text).toContain('N:King;Ada;;;');

    // Deleted on the phone; the other side's sync shows the tombstone.
    expect((await phone.request('DELETE', cardHref, { headers: { 'If-Match': etag2 } })).status).toBe(204);
    const s3 = responses((await web.request('REPORT', book, { body: iosSyncCollection(s2.syncToken ?? ''), headers: { Depth: '1' } })).xml);
    expect(s3.list.map((v) => [v.href, v.status])).toEqual([[cardHref, 404]]);
  });

  it('answers addressbook-query with match types, test and a limit', async () => {
    for (const [given, family, email] of [
      ['Grace', 'Hopper', 'grace@navy.example'],
      ['Alan', 'Turing', 'alan@d3cloud.io'],
      ['Katherine', 'Johnson', 'katherine@d3cloud.io'],
    ] as const) {
      const id = randomUUID();
      expect((await phone.request('PUT', `${book}${id}.vcf`, { body: iosCard(id, given, family, email), headers: { ...vcard, 'If-None-Match': '*' } })).status).toBe(201);
    }
    const q = (filter: string, limit = ''): string =>
      `<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:prop><D:getetag/><C:address-data/></D:prop><C:filter ${filter}</C:filter>${limit}</C:addressbook-query>`;
    const names = (r: ReturnType<typeof responses>): string[] =>
      r.list
        .filter((v) => v.status === null)
        .map((v) => /FN:(.*)\r\n/.exec(prop(v, NS.CARDDAV, 'address-data') ?? '')?.[1] ?? '')
        .sort();

    const byDomain = responses((await phone.request('REPORT', book, { body: q('test="anyof"><C:prop-filter name="EMAIL"><C:text-match match-type="ends-with">@D3CLOUD.IO</C:text-match></C:prop-filter>'), headers: { Depth: '1' } })).xml);
    expect(names(byDomain)).toEqual(['Alan Turing', 'Katherine Johnson']);

    const both = responses(
      (await phone.request('REPORT', book, {
        body: q('test="allof"><C:prop-filter name="EMAIL"><C:text-match match-type="ends-with">@d3cloud.io</C:text-match></C:prop-filter><C:prop-filter name="FN"><C:text-match match-type="starts-with">kath</C:text-match></C:prop-filter>'),
        headers: { Depth: '1' },
      })).xml,
    );
    expect(names(both)).toEqual(['Katherine Johnson']);

    const noNickname = responses((await phone.request('REPORT', book, { body: q('><C:prop-filter name="NICKNAME"><C:is-not-defined/></C:prop-filter>'), headers: { Depth: '1' } })).xml);
    expect(names(noNickname)).toEqual(['Alan Turing', 'Grace Hopper', 'Katherine Johnson']);

    const limited = responses((await phone.request('REPORT', book, { body: q('>', '<C:limit><C:nresults>2</C:nresults></C:limit>'), headers: { Depth: '1' } })).xml);
    expect(limited.list.filter((v) => v.status === null)).toHaveLength(2);
    expect(limited.byHref.get(book)?.status).toBe(507);
  });

  it('refuses a second card with the same UID, a card without one, and something that is not a vCard', async () => {
    const id = randomUUID();
    expect((await phone.request('PUT', `${book}a-${id}.vcf`, { body: iosCard(id, 'Mary', 'Somerville', 'mary@example.com'), headers: vcard })).status).toBe(201);
    const dup = await phone.request('PUT', `${book}b-${id}.vcf`, { body: iosCard(id, 'Mary', 'Somerville', 'mary@example.com'), headers: vcard });
    expect(dup.status).toBe(403);
    expect(dup.text).toContain('no-uid-conflict');
    expect(dup.text).toContain(`${book}a-${id}.vcf`);

    const noUid = iosCard('x', 'No', 'Uid', 'n@example.com').replace(/UID:x\r\n/, '');
    expect((await phone.request('PUT', `${book}nouid.vcf`, { body: noUid, headers: vcard })).status).toBe(403);
    const v21 = iosCard('v21', 'Old', 'Card', 'o@example.com').replace('VERSION:3.0', 'VERSION:2.1');
    const old = await phone.request('PUT', `${book}v21.vcf`, { body: v21, headers: vcard });
    expect(old.status).toBe(403);
    expect(old.text).toContain('supported-address-data');
    expect((await phone.request('PUT', `${book}junk.vcf`, { body: 'hello', headers: vcard })).status).toBe(403);
    expect((await phone.request('PUT', `${book}cal.vcf`, { body: 'BEGIN:VCARD\r\n', headers: { 'Content-Type': 'text/calendar' } })).status).toBe(403);
  });
});
