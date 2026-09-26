// The setup wizard's schemas (PST-REQ-098): requests are validated with these, and the OpenAPI
// document is generated from them (PST-REQ-085).
import { z } from 'zod';
import { STEPS } from './state.js';

export const DomainRequest = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(253)
    .regex(/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'a domain name, e.g. d3cloud.io'),
});

export const MailboxRequest = z.object({
  localPart: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/, 'letters, digits and . _ + -'),
});

export const TestRequest = z.object({
  outboundId: z.uuid().describe('The outbound id POST /api/compose/send answered for the test message.'),
});

export const WizardDkimKey = z.object({
  selector: z.string(),
  algorithm: z.enum(['ed25519-sha256', 'rsa-sha256']),
  dnsName: z.string().describe('Where the TXT record goes: <selector>._domainkey.<domain>.'),
  dnsRecord: z.string().describe('The TXT value to publish.'),
});

export const WizardView = z.object({
  step: z.enum(STEPS).describe('The furthest step reached; done once completed.'),
  completed: z.boolean(),
  completedAt: z.iso.datetime().nullable(),
  domain: z.string().nullable(),
  suggestedDomain: z.string().describe('The domain to offer when none is chosen yet.'),
  dkim: z.array(WizardDkimKey),
  dnsAcknowledgedAt: z.iso.datetime().nullable(),
  mailbox: z.string().nullable().describe('The address the test is sent from.'),
  addresses: z.array(z.string()).describe('The operator’s own addresses at the chosen domain.'),
  test: z.object({ outboundId: z.uuid(), to: z.array(z.string()), sentAt: z.iso.datetime() }).nullable(),
});
