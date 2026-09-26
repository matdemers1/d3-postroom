// DKIM keys for a domain. Needs DATABASE_URL and POSTROOM_KEK.
//
//   dkim-keys <domain>            make sure the domain has its Ed25519 and RSA keys (generating,
//                                 sealing and auditing whichever is missing) and print the TXT
//                                 records to publish. Idempotent: run it again to reprint them.
//   dkim-keys rotate <domain> [--force]
//                                 one rotation pass (PST-T-7.4, PST-REQ-125): retire keys past their
//                                 7-day overlap, switch to a pending key once its TXT is visible
//                                 through DNS_RESOLVER, create the next pending key when one is due
//                                 (quarterly; --force: now). Run daily from Shipyard's schedule.
//   dkim-keys status <domain>     every key, its state, and what to do with its TXT record.
//
// See docs/runbooks/dkim-rotation.md.
import { lookup, Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { DkimDns } from '@postroom/auth-checks';
import { loadKek } from '@postroom/crypto';
import { createDb } from '@postroom/db';
import { ensureDkimKeys } from '../dkim.js';
import { dkimKeyStatus, rotateDkimKeys } from '../dkim-rotation.js';

const USAGE = 'usage: dkim-keys <domain> | dkim-keys rotate <domain> [--force] | dkim-keys status <domain>\n';

function fail(message: string): never {
  process.stderr.write(message);
  process.exit(2);
}

/**
 * TXT lookups through our validating resolver (DNS_RESOLVER, host:port, default 127.0.0.1:53; a
 * compose service name such as `unbound:53` is resolved to its address first).
 */
async function resolverDns(server: string): Promise<DkimDns> {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(server.trim());
  if (m === null) fail(`DNS_RESOLVER is not host:port: ${server}\n`);
  const host = m[1] ?? '';
  const port = m[2] ?? '53';
  const address = isIP(host) === 0 ? (await lookup(host)).address : host;
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers([isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`]);
  return {
    async txt(name: string): Promise<readonly string[]> {
      try {
        return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
        throw err;
      }
    },
  };
}

const args = process.argv.slice(2);
const command = args[0] === 'rotate' || args[0] === 'status' ? args[0] : 'ensure';
const domain = command === 'ensure' ? args[0] : args[1];
if (domain === undefined || domain.trim() === '' || domain.startsWith('-')) fail(USAGE);
const force = args.includes('--force');
const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') fail('DATABASE_URL is required\n');

const db = createDb(databaseUrl);
try {
  if (command === 'ensure') {
    const keys = await ensureDkimKeys(db, loadKek({ env: process.env }), domain);
    for (const k of keys) {
      process.stdout.write(`${k.created ? 'created ' : 'existing'} ${k.algorithm} selector ${k.selector}\n`);
      process.stdout.write(`  ${k.dnsName}. IN TXT "${k.dnsRecord}"\n`);
    }
    process.stdout.write('Publish both records before sending (a TXT string over 255 octets is split into several quoted strings).\n');
  } else if (command === 'rotate') {
    const dns = await resolverDns(process.env['DNS_RESOLVER'] ?? '127.0.0.1:53');
    const events = await rotateDkimKeys(db, loadKek({ env: process.env }), domain, { dns, force });
    for (const e of events) {
      process.stdout.write(`${e.kind.padEnd(15)} ${e.algorithm} ${e.detail}\n`);
      if ((e.kind === 'created-pending' || e.kind === 'awaiting-dns') && e.dnsName !== undefined && e.dnsRecord !== undefined) {
        process.stdout.write(`  publish: ${e.dnsName}. IN TXT "${e.dnsRecord}"\n`);
      }
      if (e.kind === 'retired' && e.dnsName !== undefined) process.stdout.write(`  may remove: ${e.dnsName}. TXT\n`);
    }
  } else {
    for (const k of await dkimKeyStatus(db, domain)) {
      process.stdout.write(`${k.state.padEnd(8)} ${k.algorithm} ${k.selector} (active from ${k.activeFrom.toISOString()})\n`);
      process.stdout.write(`  ${k.instruction}\n  ${k.dnsName}. IN TXT "${k.dnsRecord}"\n`);
    }
  }
} finally {
  await db.$disconnect();
}
