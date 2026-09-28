// PST-T-4.15, PST-REQ-186: the DNS checker's rua= suggestions, report ingest, the Deliverability
// screen's DMARC address and the DMARC proposals all name the same report mailboxes, from the one
// shared definition — and by default they are what production DNS already publishes.
import { describe, expect, it } from 'vitest';
import { DMARC_REPORTS_LOCAL_PART, reportMailboxesFor, ruaOf, TLS_REPORTS_LOCAL_PART, type Db } from '@postroom/db';
import { reportAddresses } from '../../../worker/src/reports/config.js';
import { hostsFromEnv } from '../../src/admin-dns/expected.js';
import { ruaAddresses } from '../../src/admin-dns/addresses.js';
import { reportAddress } from '../../src/deliverability/index.js';
import { ruaAddress } from '../../src/deliverability/proposals.js';

const DOMAIN = 'd3cloud.io';

/** Just enough of Prisma for the three readers: one primary domain. */
const fakeDb = {
  domain: {
    findFirst: () => Promise.resolve({ id: 'd1', name: DOMAIN, isPrimary: true }),
    findUnique: ({ where }: { where: { name: string } }) => Promise.resolve(where.name === DOMAIN ? { id: 'd1', name: DOMAIN, isPrimary: true } : null),
    findMany: () => Promise.resolve([{ id: 'd1', name: DOMAIN, isPrimary: true }]),
  },
} as unknown as Db;

const ENVS: Record<string, NodeJS.ProcessEnv> = {
  defaults: {},
  overridden: { REPORTS_MAILBOX: 'Rua@D3cloud.io', TLSRPT_MAILBOX: 'tls@d3cloud.io, tls2@d3cloud.io' },
};

describe('report mailboxes agree everywhere (PST-T-4.15)', () => {
  it('defaults to dmarc-reports@ and tls-reports@ the domain — what the published DNS names', () => {
    expect(DMARC_REPORTS_LOCAL_PART).toBe('dmarc-reports');
    expect(TLS_REPORTS_LOCAL_PART).toBe('tls-reports');
    expect(reportMailboxesFor({}, DOMAIN)).toEqual({ dmarc: ['dmarc-reports@d3cloud.io'], tls: ['tls-reports@d3cloud.io'] });
    const hosts = hostsFromEnv({}, DOMAIN, 'https://mail.d3cloud.io');
    expect(hosts.dmarcRua).toBe('mailto:dmarc-reports@d3cloud.io');
    expect(hosts.tlsRptRua).toBe('mailto:tls-reports@d3cloud.io');
  });

  for (const [label, env] of Object.entries(ENVS)) {
    it(`the DNS checker, ingest, Deliverability and the proposals name the same mailboxes (${label})`, async () => {
      const shared = reportMailboxesFor(env, DOMAIN);
      // The DNS checker: what it suggests publishing.
      const hosts = hostsFromEnv(env, DOMAIN, 'https://mail.d3cloud.io');
      expect(hosts.dmarcRua).toBe(ruaOf(shared.dmarc));
      expect(hosts.tlsRptRua).toBe(ruaOf(shared.tls));
      expect(ruaAddresses(hosts.dmarcRua)).toEqual(shared.dmarc);
      expect(ruaAddresses(hosts.tlsRptRua)).toEqual(shared.tls);
      // Report ingest: what the sweep reads.
      expect(await reportAddresses(fakeDb, env)).toEqual([...shared.dmarc, ...shared.tls]);
      // Deliverability: the address the screen names.
      expect(await reportAddress(fakeDb, env)).toBe(shared.dmarc[0]);
      // DMARC proposals: the rua= a proposed record carries is the one the checker suggests.
      expect(await ruaAddress(fakeDb, env, DOMAIN)).toBe(hosts.dmarcRua);
    });
  }

  it('DMARC_RUA / TLSRPT_RUA stay verbatim overrides of the published value, and the proposals follow', async () => {
    const env = { DMARC_RUA: 'mailto:x@d3cloud.io', TLSRPT_RUA: 'mailto:y@d3cloud.io' };
    const hosts = hostsFromEnv(env, DOMAIN, 'https://mail.d3cloud.io');
    expect(hosts.dmarcRua).toBe('mailto:x@d3cloud.io');
    expect(hosts.tlsRptRua).toBe('mailto:y@d3cloud.io');
    expect(await ruaAddress(fakeDb, env, DOMAIN)).toBe('mailto:x@d3cloud.io');
  });

  it('reads the addresses out of a rua= value, dropping size limits and non-mailto URIs', () => {
    expect(ruaAddresses('mailto:A@x.io!10m, https://r.example/, mailto:b@y.io')).toEqual(['a@x.io', 'b@y.io']);
  });
});
