// Proves PST-T-3.7's doneWhen against a real PostgreSQL 16: a body-only word is found, and every
// operator filters as expected, over ~30 seeded messages across two accounts and several mailboxes.
import { randomBytes } from 'node:crypto';
import type { Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexMessage } from '../../src/index-message.js';
import { parseQuery } from '../../src/parser.js';
import { searchMessages } from '../../src/sql.js';

const baseUrl = process.env['DATABASE_URL'];

interface Seeded {
  messageId: string;
  mailboxId: string;
  uid: number;
}

async function makeAccount(db: Db, displayName: string): Promise<string> {
  const account = await db.account.create({ data: { displayName } });
  return account.id;
}

async function makeMailbox(db: Db, accountId: string, name: string, specialUse?: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'rejects'): Promise<string> {
  const mailbox = await db.mailbox.create({ data: { accountId, name, uidvalidity: 1, ...(specialUse !== undefined ? { specialUse } : {}) } });
  return mailbox.id;
}

let uidCounter = 1;

interface MakeMessageInput {
  accountId: string;
  mailboxId: string;
  subject: string;
  from: string;
  to?: string;
  bodyText: string;
  attachmentNames?: string[];
  hasAttachment?: boolean;
  flags?: string[];
  internalDate?: Date;
  size?: number;
}

async function makeMessage(db: Db, input: MakeMessageInput): Promise<Seeded> {
  const sha256 = randomBytes(32).toString('hex');
  await db.blob.create({
    data: { sha256, size: 10, wrappedDek: randomBytes(16), kekId: 'test-kek', aead: 'aes-256-gcm', nonce: randomBytes(12) },
  });
  const uid = uidCounter++;
  const message = await db.message.create({
    data: {
      mailboxId: input.mailboxId,
      uid,
      modseq: 1n,
      blobSha256: sha256,
      size: input.size ?? 100,
      internalDate: input.internalDate ?? new Date(),
      subject: input.subject,
      fromAddress: input.from,
      flags: input.flags ?? [],
    },
  });
  await indexMessage(db, {
    messageId: message.id,
    accountId: input.accountId,
    subject: input.subject,
    from: input.from,
    to: input.to ?? '',
    bodyText: input.bodyText,
    attachmentNames: input.attachmentNames ?? [],
    ...(input.hasAttachment !== undefined ? { hasAttachment: input.hasAttachment } : {}),
  });
  return { messageId: message.id, mailboxId: input.mailboxId, uid };
}

async function run(db: Db, accountId: string, query: string, mailboxId?: string) {
  const { ast } = parseQuery(query);
  return searchMessages(db, ast, { accountId, limit: 100, ...(mailboxId !== undefined ? { mailboxId } : {}) });
}

describe.skipIf(!baseUrl)('search (PST-T-3.7)', () => {
  let tdb: TestDatabase;
  let db: Db;

  let accountA: string;
  let accountB: string;
  let inboxA: string;
  let sentA: string;
  let inboxB: string;

  let dragonBody: Seeded;
  let fromAlice: Seeded;
  let toBob: Seeded;
  let subjectInvoice: Seeded;
  let withAttachment: Seeded;
  let withoutAttachment: Seeded;
  let inSentA: Seeded;
  let oldMessage: Seeded;
  let newMessage: Seeded;
  let unreadMessage: Seeded;
  let readMessage: Seeded;
  let negatedTarget: Seeded;
  let negatedOther: Seeded;
  let orA: Seeded;
  let orB: Seeded;
  let phraseMessage: Seeded;
  let subjectHit: Seeded;
  let bodyHit: Seeded;
  let accountBSecret: Seeded;
  let quoteInjection: Seeded;
  let percentInjection: Seeded;
  let percentDecoy: Seeded;
  let underscoreInjection: Seeded;
  let underscoreDecoy: Seeded;
  let backslashInjection: Seeded;

  beforeAll(async () => {
    tdb = await createTestDatabase(baseUrl ?? '', 'pst_t37');
    db = tdb.db;

    accountA = await makeAccount(db, 'Account A');
    accountB = await makeAccount(db, 'Account B');
    inboxA = await makeMailbox(db, accountA, 'INBOX', 'inbox');
    sentA = await makeMailbox(db, accountA, 'Sent', 'sent');
    inboxB = await makeMailbox(db, accountB, 'INBOX', 'inbox');

    // Filler messages so the corpus is realistically sized (~30 total) without every one needing
    // its own named variable.
    for (let i = 0; i < 15; i++) {
      await makeMessage(db, {
        accountId: accountA,
        mailboxId: inboxA,
        subject: `Filler message ${i}`,
        from: 'noreply@example.com',
        bodyText: `This is filler body text number ${i} about weather and lunch.`,
      });
    }
    for (let i = 0; i < 5; i++) {
      await makeMessage(db, {
        accountId: accountB,
        mailboxId: inboxB,
        subject: `Other account filler ${i}`,
        from: 'noreply@example.com',
        bodyText: 'Nothing interesting here.',
      });
    }

    dragonBody = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Ordinary subject',
      from: 'carol@example.com',
      bodyText: 'The quick brown dragon jumped over the lazy wizard.',
    });

    fromAlice = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Meeting notes',
      from: 'alice@example.com',
      bodyText: 'Notes from the meeting.',
    });

    toBob = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Project update',
      from: 'dave@example.com',
      to: 'bob@example.com',
      bodyText: 'Here is the project update.',
    });

    subjectInvoice = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Your invoice is ready',
      from: 'billing@example.com',
      bodyText: 'Please find attached your invoice.',
    });

    withAttachment = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Photos from the trip',
      from: 'erin@example.com',
      bodyText: 'See attached photos.',
      attachmentNames: ['beach.jpg', 'sunset.png'],
      hasAttachment: true,
    });

    withoutAttachment = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'No attachment here',
      from: 'frank@example.com',
      bodyText: 'Just text, nothing attached.',
    });

    inSentA = await makeMessage(db, {
      accountId: accountA,
      mailboxId: sentA,
      subject: 'Reply to invoice question',
      from: 'me@example.com',
      bodyText: 'Sent from the sent folder.',
    });

    oldMessage = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Old news',
      from: 'grace@example.com',
      bodyText: 'This happened a long time ago.',
      internalDate: new Date('2020-01-01T00:00:00Z'),
    });

    newMessage = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Fresh news',
      from: 'heidi@example.com',
      bodyText: 'This just happened.',
      internalDate: new Date('2030-01-01T00:00:00Z'),
    });

    unreadMessage = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Unread item',
      from: 'ivan@example.com',
      bodyText: 'Please read this unread message.',
      flags: [],
    });

    readMessage = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Read item',
      from: 'judy@example.com',
      bodyText: 'This one was already read.',
      flags: ['\\Seen'],
    });

    negatedTarget = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Banana bread recipe',
      from: 'kim@example.com',
      bodyText: 'How to bake banana bread.',
    });

    negatedOther = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Apple pie recipe',
      from: 'liam@example.com',
      bodyText: 'How to bake apple pie.',
    });

    orA = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Basketball scores',
      from: 'mona@example.com',
      bodyText: 'The basketball game was exciting.',
    });

    orB = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Soccer scores',
      from: 'nate@example.com',
      bodyText: 'The soccer game was exciting.',
    });

    phraseMessage = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'A phrase test',
      from: 'olive@example.com',
      bodyText: 'This contains the exact phrase gentle purple giraffe somewhere in it.',
    });

    subjectHit = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Xylophone lessons this week',
      from: 'pat@example.com',
      bodyText: 'Nothing else relevant in the body.',
    });

    bodyHit = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Unrelated subject line',
      from: 'quinn@example.com',
      bodyText: 'This body just happens to mention xylophone once.',
    });

    accountBSecret = await makeMessage(db, {
      accountId: accountB,
      mailboxId: inboxB,
      subject: 'Ordinary subject',
      from: 'carol@example.com',
      bodyText: 'The quick brown dragon jumped over the lazy wizard too.',
    });

    quoteInjection = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: "It's a trap",
      from: "o'brien@example.com",
      bodyText: "Contains a quote ' and another \" in the body.",
    });

    percentInjection = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Save 100% today',
      from: 'percent@example.com',
      bodyText: 'This body has a literal percent sign in the subject.',
    });

    percentDecoy = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Save 100 today',
      from: 'percentdecoy@example.com',
      bodyText: 'Unrelated body text.',
    });

    underscoreInjection = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'report_final is attached',
      from: 'underscore@example.com',
      bodyText: 'Unrelated body text.',
    });

    underscoreDecoy = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'reportXfinal is attached',
      from: 'underscoredecoy@example.com',
      bodyText: 'Unrelated body text.',
    });

    backslashInjection = await makeMessage(db, {
      accountId: accountA,
      mailboxId: inboxA,
      subject: 'Backslash literal',
      from: 'backslash@example.com',
      bodyText: 'Windows path C:\\Users\\test\\file.txt is mentioned here.',
    });
  }, 60_000);

  afterAll(async () => {
    await tdb.drop();
  });

  it('finds a body-only word', async () => {
    const rows = await run(db, accountA, 'dragon');
    expect(rows.map((r) => r.messageId)).toContain(dragonBody.messageId);
  });

  it('never returns another account\'s matching message (account isolation)', async () => {
    const rows = await run(db, accountA, 'dragon');
    expect(rows.map((r) => r.messageId)).not.toContain(accountBSecret.messageId);

    const rowsB = await run(db, accountB, 'dragon');
    expect(rowsB.map((r) => r.messageId)).toContain(accountBSecret.messageId);
    expect(rowsB.map((r) => r.messageId)).not.toContain(dragonBody.messageId);
  });

  it('filters by from:', async () => {
    const rows = await run(db, accountA, 'from:alice@example.com');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(fromAlice.messageId);
    expect(ids).not.toContain(toBob.messageId);
  });

  it('filters by to:', async () => {
    const rows = await run(db, accountA, 'to:bob@example.com');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(toBob.messageId);
    expect(ids).not.toContain(fromAlice.messageId);
  });

  it('filters by subject:', async () => {
    const rows = await run(db, accountA, 'subject:invoice');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(subjectInvoice.messageId);
    expect(ids).not.toContain(fromAlice.messageId);
  });

  it('filters by has:attachment', async () => {
    const rows = await run(db, accountA, 'has:attachment');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(withAttachment.messageId);
    expect(ids).not.toContain(withoutAttachment.messageId);
  });

  it('filters by in:sent', async () => {
    const rows = await run(db, accountA, 'in:sent');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(inSentA.messageId);
    expect(ids).not.toContain(fromAlice.messageId);
  });

  it('filters by before:', async () => {
    const rows = await run(db, accountA, 'before:2021-01-01');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(oldMessage.messageId);
    expect(ids).not.toContain(newMessage.messageId);
  });

  it('filters by after:', async () => {
    const rows = await run(db, accountA, 'after:2025-01-01');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(newMessage.messageId);
    expect(ids).not.toContain(oldMessage.messageId);
  });

  it('filters by is:unread', async () => {
    const rows = await run(db, accountA, 'is:unread');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(unreadMessage.messageId);
    expect(ids).not.toContain(readMessage.messageId);
  });

  it('filters by is:read', async () => {
    const rows = await run(db, accountA, 'is:read');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(readMessage.messageId);
    expect(ids).not.toContain(unreadMessage.messageId);
  });

  it('excludes a -negated word', async () => {
    const rows = await run(db, accountA, 'recipe -banana');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(negatedOther.messageId);
    expect(ids).not.toContain(negatedTarget.messageId);
  });

  it('matches either side of OR', async () => {
    const rows = await run(db, accountA, 'basketball OR soccer');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(orA.messageId);
    expect(ids).toContain(orB.messageId);
  });

  it('matches an exact phrase', async () => {
    const rows = await run(db, accountA, '"gentle purple giraffe"');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(phraseMessage.messageId);
  });

  it('does not match a phrase whose words appear but not in order', async () => {
    // "giraffe gentle" never appears as a phrase in the corpus.
    const rows = await run(db, accountA, '"giraffe gentle purple"');
    const ids = rows.map((r) => r.messageId);
    expect(ids).not.toContain(phraseMessage.messageId);
  });

  it('ranks a subject hit above a body-only hit for the same word', async () => {
    const rows = await run(db, accountA, 'xylophone');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(subjectHit.messageId);
    expect(ids).toContain(bodyHit.messageId);
    const subjectIndex = ids.indexOf(subjectHit.messageId);
    const bodyIndex = ids.indexOf(bodyHit.messageId);
    expect(subjectIndex).toBeLessThan(bodyIndex);
  });

  it('does not break or widen results on a quote in a from: value', async () => {
    const rows = await run(db, accountA, `from:"o'brien@example.com"`);
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(quoteInjection.messageId);
    expect(ids.length).toBeLessThan(30);
  });

  it('does not break or widen results on a quote in a body word', async () => {
    const rows = await run(db, accountA, 'trap');
    expect(rows.map((r) => r.messageId)).toContain(quoteInjection.messageId);
  });

  it('treats a literal % in an operator value as a literal character, not an ILIKE wildcard', async () => {
    const rows = await run(db, accountA, 'subject:"100%"');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(percentInjection.messageId);
    // If '%' leaked into the pattern unescaped, "100%" would degrade to "contains 100" and also
    // match the decoy subject "Save 100 today".
    expect(ids).not.toContain(percentDecoy.messageId);
  });

  it('treats a literal _ in an operator value as a literal character, not an ILIKE single-char wildcard', async () => {
    const rows = await run(db, accountA, 'subject:"report_final"');
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(underscoreInjection.messageId);
    // If '_' leaked into the pattern unescaped, it would match any single character, including the
    // decoy subject "reportXfinal is attached".
    expect(ids).not.toContain(underscoreDecoy.messageId);
  });

  it('handles a literal backslash in a search term without breaking the query or matching everything', async () => {
    const rows = await run(db, accountA, String.raw`C:\Users`);
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(backslashInjection.messageId);
    expect(ids).not.toContain(dragonBody.messageId);
  });

  it("a SQL-injection-shaped subject: value never widens results to another account's messages", async () => {
    const rows = await run(db, accountA, `subject:"'; DROP TABLE message_search; --"`);
    expect(rows.map((r) => r.messageId)).not.toContain(accountBSecret.messageId);
    expect(rows).toHaveLength(0);

    // The table must still exist and be queryable afterwards.
    const stillWorks = await run(db, accountA, 'dragon');
    expect(stillWorks.map((r) => r.messageId)).toContain(dragonBody.messageId);
  });

  it('scopes to a single mailbox when mailboxId is given', async () => {
    const rows = await run(db, accountA, 'invoice', inboxA);
    const ids = rows.map((r) => r.messageId);
    expect(ids).toContain(subjectInvoice.messageId);
    expect(ids).not.toContain(inSentA.messageId);
  });
});
