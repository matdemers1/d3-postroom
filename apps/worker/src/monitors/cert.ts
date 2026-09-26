// TLS certificate expiry (PST-REQ-021, PST-REQ-097): parse each configured PEM's `notAfter` with
// node:crypto's X509Certificate (no ASN.1 library) and fire when any is within `warnDays`.
// TLS_CERT_FILES is a comma list; leave it unset (or empty) to disable this monitor, e.g. in a dev
// environment where smtp-in/submission/imap run without a certificate at all.
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import type { Monitor } from './types.js';

export interface CertMonitorOptions {
  readonly files: readonly string[];
  readonly warnDays?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly readCert?: ((file: string) => Buffer | string) | undefined;
}

const DEFAULT_WARN_DAYS = 14;
const MS_PER_DAY = 86_400_000;

interface CertCheck {
  readonly file: string;
  readonly daysLeft: number | null;
  readonly error: string | null;
}

export function createCertMonitor(opts: CertMonitorOptions): Monitor | null {
  if (opts.files.length === 0) return null;
  const warnDays = opts.warnDays ?? DEFAULT_WARN_DAYS;
  const now = opts.now ?? ((): Date => new Date());
  const readCert = opts.readCert ?? ((file: string): Buffer => readFileSync(file));

  return {
    name: 'cert-expiry',
    check: () => {
      const results: CertCheck[] = opts.files.map((file) => {
        try {
          const cert = new X509Certificate(readCert(file));
          const daysLeft = (new Date(cert.validTo).getTime() - now().getTime()) / MS_PER_DAY;
          return { file, daysLeft, error: null };
        } catch (error) {
          return { file, daysLeft: null, error: error instanceof Error ? error.message : String(error) };
        }
      });
      const failing = results.filter((r) => r.error !== null || (r.daysLeft !== null && r.daysLeft < warnDays));
      if (failing.length === 0) {
        return Promise.resolve({ ok: true, detail: `all certificates valid for at least ${String(warnDays)} days`, value: results });
      }
      const detail = failing
        .map((r) => (r.error !== null ? `${r.file}: ${r.error}` : `${r.file}: expires in ${r.daysLeft?.toFixed(1) ?? '?'} days`))
        .join('; ');
      return Promise.resolve({ ok: false, detail, value: results });
    },
  };
}
