// `node dist/cli/dkim-keys.js <domain>`: make sure the domain has its Ed25519 and RSA DKIM keys
// (generating, sealing and auditing whichever is missing) and print the TXT records to publish.
// Needs DATABASE_URL and POSTROOM_KEK. Idempotent: run it again to reprint the records.
import { loadKek } from '@postroom/crypto';
import { createDb } from '@postroom/db';
import { ensureDkimKeys } from '../dkim.js';

const domain = process.argv[2];
if (domain === undefined || domain.trim() === '') {
  process.stderr.write('usage: dkim-keys <domain>\n');
  process.exit(2);
}
const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(2);
}

const db = createDb(databaseUrl);
try {
  const keys = await ensureDkimKeys(db, loadKek({ env: process.env }), domain);
  for (const k of keys) {
    process.stdout.write(`${k.created ? 'created ' : 'existing'} ${k.algorithm} selector ${k.selector}\n`);
    process.stdout.write(`  ${k.dnsName}. IN TXT "${k.dnsRecord}"\n`);
  }
  process.stdout.write('Publish both records before sending (a TXT string over 255 octets is split into several quoted strings).\n');
} finally {
  await db.$disconnect();
}
