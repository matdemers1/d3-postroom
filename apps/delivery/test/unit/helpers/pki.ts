// A throwaway PKI for the outbound TLS policy tests (PST-T-7.5), made with the openssl CLI the way
// the other delivery tests make their certificates: a test CA standing in for the WebPKI roots,
// leaves it signs, and a self-signed leaf no root vouches for. Returns undefined without openssl.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface Pem {
  key: string;
  cert: string;
}

export interface TestPki {
  ca: Pem;
  /** Leaf signed by the CA for each name in `names`. */
  signed: (label: string, names: string[]) => Pem;
  /** Self-signed leaf for `names`: valid name, untrusted issuer. */
  selfSigned: (label: string, names: string[]) => Pem;
  cleanup: () => void;
}

const EC = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];

export function makeTestPki(): TestPki | undefined {
  let dir: string;
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'pst-t75-pki-'));
    const run = (args: string[]): void => { execFileSync('openssl', args, { stdio: 'ignore' }); };
    const file = (name: string): string => path.join(dir, name);
    const read = (name: string): string => readFileSync(file(name), 'utf8');

    run(['req', '-x509', ...EC, '-keyout', file('ca.key'), '-out', file('ca.pem'), '-days', '2', '-subj', '/CN=Postroom Test Root',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    const ca: Pem = { key: read('ca.key'), cert: read('ca.pem') };

    const san = (names: string[]): string => `subjectAltName=${names.map((n) => `DNS:${n}`).join(',')}`;

    return {
      ca,
      signed: (label, names) => {
        run(['req', '-new', ...EC, '-keyout', file(`${label}.key`), '-out', file(`${label}.csr`), '-subj', `/CN=${names[0] ?? label}`]);
        writeFileSync(file(`${label}.ext`), `${san(names)}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
        run(['x509', '-req', '-in', file(`${label}.csr`), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAcreateserial',
          '-out', file(`${label}.pem`), '-days', '1', '-extfile', file(`${label}.ext`)]);
        return { key: read(`${label}.key`), cert: read(`${label}.pem`) };
      },
      selfSigned: (label, names) => {
        run(['req', '-x509', ...EC, '-keyout', file(`${label}.key`), '-out', file(`${label}.pem`), '-days', '1',
          '-subj', `/CN=${names[0] ?? label}`, '-addext', san(names)]);
        return { key: read(`${label}.key`), cert: read(`${label}.pem`) };
      },
      cleanup: () => { rmSync(dir, { recursive: true, force: true }); },
    };
  } catch (error) {
    console.warn(`openssl unavailable, skipping the TLS policy tests: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
