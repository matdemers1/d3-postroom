// The DNS checker's schemas (PST-REQ-099): the query is validated with these, and the OpenAPI
// document is generated from them (PST-REQ-085).
import { z } from 'zod';

export const DnsQuery = z.object({
  domain: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$/, 'a domain name')
    .optional()
    .describe('One of Postroom’s domains; default the primary.'),
});

export const CheckStatus = z.enum(['pass', 'fail', 'missing', 'pending', 'unknown']);

export const DnsCheckRow = z.object({
  record: z.enum(['MX', 'SPF', 'DKIM', 'DMARC', 'PTR', 'MTA-STS', 'MTA-STS host', 'TLS-RPT', 'SRV', 'autoconfig', 'autodiscover']),
  name: z.string().describe('The owner name.'),
  type: z.enum(['MX', 'TXT', 'PTR', 'SRV', 'CNAME']),
  expected: z.string().nullable().describe('The value to publish; null when it cannot be known yet (no edge, no DKIM key).'),
  afterGoLive: z.boolean().describe('Published only after the security gate (PST-REQ-086); absent before then is pending.'),
  note: z.string().nullable(),
  live: z.array(z.string()).describe('What the resolver answers now.'),
  status: CheckStatus.describe('unknown means the resolver did not answer; it is never a pass.'),
  reason: z.string(),
});

export const DnsReport = z.object({
  domain: z.string(),
  resolver: z.string().describe('The resolver the answers came from (DNS_RESOLVER).'),
  checkedAt: z.iso.datetime(),
  summary: z.object({ pass: z.number().int(), fail: z.number().int(), missing: z.number().int(), pending: z.number().int(), unknown: z.number().int() }),
  rows: z.array(DnsCheckRow),
});
