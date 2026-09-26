// The DNS checker in the OpenAPI document (PST-REQ-085), from the same zod objects the route
// validates with. Spread into ROUTES/COMPONENTS by src/openapi/document.ts.
import type { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import * as D from './schemas.js';

export const ADMIN_DNS_COMPONENTS: Record<string, z.ZodType> = {
  DnsCheckRow: D.DnsCheckRow,
  DnsReport: D.DnsReport,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });

export const ADMIN_DNS_ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/admin/dns',
    operationId: 'checkDns',
    tag: 'Admin',
    summary: 'Expected vs live DNS for one of Postroom’s domains, with pass/fail per record (PST-REQ-099).',
    description:
      'MX, SPF (evaluated for EDGE_PUBLIC_IP), DKIM (p= compared per live selector), DMARC (parsed), PTR (forward-confirmed), MTA-STS, TLS-RPT, SRV and autoconfig/autodiscover. Answers come from Postroom’s own resolver (DNS_RESOLVER). A resolver that does not answer makes a row unknown, never pass. Nothing at a no-reply subdomain is ever checked. Admin only.',
    query: D.DnsQuery,
    responses: {
      '200': { description: 'The report.', schema: 'DnsReport' },
      '400': err('Invalid domain, or a no-reply subdomain (Cloudflare Email Service’s, never touched).'),
      '401': err('No session.'),
      '403': err('Not an admin.'),
      '404': err('Not a domain Postroom serves.'),
    },
  },
];
