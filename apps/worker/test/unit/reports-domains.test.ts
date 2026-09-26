// PST-T-7.2 / PST-T-7.9: which reported domains are ours — case-insensitive, subdomains included.
import { describe, expect, it } from 'vitest';
import { classifyDmarc, classifyTlsRpt, isOurDomain } from '../../src/reports/domains.js';

const ours = new Set(['d3cloud.io']);

describe('isOurDomain', () => {
  it('matches ours in any case, with or without a trailing dot, and its subdomains', () => {
    expect(isOurDomain('D3cloud.IO', ours)).toBe(true);
    expect(isOurDomain('d3cloud.io.', ours)).toBe(true);
    expect(isOurDomain('mail.d3cloud.io', ours)).toBe(true);
  });

  it('never matches a lookalike suffix', () => {
    expect(isOurDomain('evild3cloud.io', ours)).toBe(false);
    expect(isOurDomain('d3cloud.io.example.org', ours)).toBe(false);
    expect(isOurDomain('example.org', ours)).toBe(false);
  });
});

describe('classify', () => {
  it('a mixed-case DMARC policy domain is ours', () => {
    expect(classifyDmarc('D3Cloud.io', ours).status).toBe('ours');
  });

  it('a TLS-RPT report naming one of our subdomains is ours', () => {
    expect(classifyTlsRpt(['example.org', 'MX.d3cloud.io'], ours).status).toBe('ours');
    expect(classifyTlsRpt(['example.org'], ours).status).toBe('foreign');
  });
});
