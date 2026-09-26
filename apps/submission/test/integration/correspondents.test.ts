// PST-T-5.8 (PST-REQ-102): acceptSubmission maintains the correspondent table (the reply graph) in
// the same transaction it records recipients — one upsert per distinct normalized address, bumping
// count and lastWrittenAt, and never for the submitter's own addresses. Both callers of
// acceptSubmission (the SMTP daemon, submittedVia: 'submission', and the webmail composer,
// submittedVia: 'webmail') share this code path, so exercising it directly proves both upsert.
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek, type Kek } from '@postroom/crypto';
import { AddressKind, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptSubmission, type AcceptDeps, type AcceptInput } from '../../src/accept.js';
import { ensureDkimKeys } from '../../src/dkim.js';

const baseUrl = process.env['DATABASE_URL'];
const DOMAIN = 'd3cloud.io';

describe.skipIf(baseUrl === undefined)('correspondent table maintained on send (PST-T-5.8, PST-REQ-102)', () => {
  let t: TestDatabase;
  let db: Db;
  let kek: Kek;
  let blobs: BlobStore;
  let blobRoot = '';
  let accountId = '';

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t58');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: DOMAIN });
    kek = generateKek();
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t58-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek });
    await ensureDkimKeys(db, kek, DOMAIN);

    const d = await db.domain.upsert({ where: { name: DOMAIN }, update: {}, create: { name: DOMAIN } });
    const account = await db.account.create({ data: { displayName: 'sender' } });
    await db.address.create({ data: { localPart: 'sender', domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
    accountId = account.id;
  }, 120_000);

  afterAll(async () => {
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  function messageBody(to: string, subject: string): Readable {
    return Readable.from([
      Buffer.from(
        `From: sender@${DOMAIN}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${randomUUID()}@${DOMAIN}>\r\n\r\nhi\r\n`,
        'latin1',
      ),
    ]);
  }

  async function accept(opts: { to: string; subject: string; submittedVia: string; now: Date }): Promise<void> {
    const input: AcceptInput = {
      submitter: { accountId, addresses: new Set([`sender@${DOMAIN}`]) },
      envelopeFrom: `sender@${DOMAIN}`,
      recipients: [{ address: opts.to }],
      sessionId: randomUUID(),
      submittedVia: opts.submittedVia,
      enforceCaps: () => Promise.resolve(),
      auditContext: { requestId: randomUUID(), ip: null },
    };
    const deps: AcceptDeps = {
      db,
      storage: () => ({ blobs, kek }),
      now: () => opts.now,
      log: () => {},
    };
    const outcome = await acceptSubmission(messageBody(opts.to, opts.subject), input, deps);
    if (!outcome.ok) throw new Error(`accept failed: ${outcome.reason}`);
    expect(outcome.ok).toBe(true);
  }

  it('an SMTP submission upserts the recipient into the correspondent table', async () => {
    const now = new Date(Date.now() + 1_000);
    await accept({ to: 'alice@example.org', subject: 'hi', submittedVia: 'submission', now });
    const row = await db.correspondent.findUnique({ where: { accountId_address: { accountId, address: 'alice@example.org' } } });
    expect(row).toMatchObject({ address: 'alice@example.org', count: 1 });
    expect(row?.firstWrittenAt).toEqual(now);
    expect(row?.lastWrittenAt).toEqual(now);
  });

  it('a webmail send (submittedVia: webmail) upserts too, and a second send bumps count/lastWrittenAt', async () => {
    const first = new Date(Date.now() + 2_000);
    const second = new Date(Date.now() + 3_000);
    await accept({ to: 'bob+newsletter@example.net', subject: 'one', submittedVia: 'webmail', now: first });
    await accept({ to: 'BOB@Example.net', subject: 'two', submittedVia: 'webmail', now: second });
    // A `+tag` and case differ across the two sends; normalizeAddress folds them to the same row.
    const row = await db.correspondent.findUnique({ where: { accountId_address: { accountId, address: 'bob@example.net' } } });
    expect(row).toMatchObject({ count: 2 });
    expect(row?.firstWrittenAt).toEqual(first);
    expect(row?.lastWrittenAt).toEqual(second);
  });

  it('never records the submitter sending to themself', async () => {
    await accept({ to: `sender@${DOMAIN}`, subject: 'note to self', submittedVia: 'submission', now: new Date() });
    const row = await db.correspondent.findUnique({ where: { accountId_address: { accountId, address: `sender@${DOMAIN}` } } });
    expect(row).toBeNull();
  });
});
