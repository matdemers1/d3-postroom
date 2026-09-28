// The certificate pair on the shared certs volume (PST-T-0.15, PST-T-11.13): the renewal decision,
// and an atomic write the daemons' hot-reload watchers can never see half of.
//
// Each file is written to a temp name in the same directory, fsynced, then renamed over the old
// one — a rename within a filesystem is atomic, so a reader sees the old file or the new, never a
// torn one. The key goes first, then the chain; between the two renames the watcher may read a
// new key beside the old certificate, which it rejects (they do not match) and keeps serving the
// old pair until the chain lands a moment later. The directory is fsynced last so both renames
// survive a crash.
//
// Modes: the key is 0640 and the directory 0750. Every daemon in the image runs as the same `node`
// user, so owner-read is what lets smtp-in, submission, imap and managesieve read the pair through
// their read-only mount; the group bit leaves room for a split-uid deployment without handing the
// key to everyone.
import { randomBytes, X509Certificate, createPrivateKey } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const MS_PER_DAY = 86_400_000;

export interface ExistingCert {
  readonly notAfter: Date;
  readonly daysLeft: number;
  readonly domains: readonly string[];
  readonly serial: string;
  readonly keyMatches: boolean;
}

/** The dNSName entries of a certificate, lower case. */
export function sanDomains(cert: X509Certificate): string[] {
  const san = cert.subjectAltName ?? '';
  return san
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DNS:'))
    .map((s) => s.slice(4).toLowerCase());
}

/** The first certificate of a PEM chain. */
export function leafOf(chainPem: string): X509Certificate {
  const m = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(chainPem);
  if (m === null) throw new Error('no certificate in the PEM');
  return new X509Certificate(m[0]);
}

/** Read the pair at `certFile`/`keyFile`; null when the certificate is missing. */
export async function readExisting(certFile: string, keyFile: string, now: Date): Promise<ExistingCert | null> {
  let chain: string;
  try {
    chain = await readFile(certFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const leaf = leafOf(chain);
  let keyMatches: boolean;
  try {
    keyMatches = leaf.checkPrivateKey(createPrivateKey(await readFile(keyFile)));
  } catch {
    keyMatches = false;
  }
  const notAfter = new Date(leaf.validTo);
  return { notAfter, daysLeft: (notAfter.getTime() - now.getTime()) / MS_PER_DAY, domains: sanDomains(leaf), serial: leaf.serialNumber, keyMatches };
}

/** Why the pair must be (re)issued, or null when it is fine for now. */
export function renewalReason(existing: ExistingCert | null, domains: readonly string[], renewDays: number): string | null {
  if (existing === null) return 'no certificate yet';
  if (!existing.keyMatches) return 'the private key is missing or does not match the certificate';
  const uncovered = domains.filter((d) => !existing.domains.includes(d));
  if (uncovered.length > 0) return `the certificate does not cover ${uncovered.join(', ')}`;
  if (existing.daysLeft < renewDays) return `expires in ${existing.daysLeft.toFixed(1)} days (renew below ${String(renewDays)})`;
  return null;
}

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Write `data` to `path` atomically: temp file in the same dir, fsync, chmod, rename. */
export async function writeFileAtomic(path: string, data: string | Uint8Array, mode: number): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } catch (error) {
    await fh.close();
    await rm(tmp, { force: true });
    throw error;
  }
  await fh.close();
  try {
    // open()'s mode is filtered by the umask; set it exactly.
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export const KEY_MODE = 0o640;
export const CERT_MODE = 0o644;
export const DIR_MODE = 0o750;

/** Install a new pair: key first, then chain, then fsync the directory. */
export async function installPair(paths: { dir: string; cert: string; key: string }, pair: { keyPem: string; certPem: string }): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: DIR_MODE });
  await writeFileAtomic(paths.key, pair.keyPem, KEY_MODE);
  await writeFileAtomic(paths.cert, pair.certPem, CERT_MODE);
  await fsyncDir(paths.dir);
}
