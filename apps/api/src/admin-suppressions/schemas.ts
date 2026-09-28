// The suppression list's schemas (PST-T-11.10, PST-REQ-178/179): the routes validate with these and
// the OpenAPI document is generated from them (PST-REQ-085).
import { z } from 'zod';

export const SuppressionListQuery = z.object({
  q: z.string().trim().min(1).max(320).optional().describe('Only addresses containing this text (case-insensitive).'),
  limit: z.coerce.number().int().min(1).max(500).optional().describe('At most this many, newest first; default 100.'),
});

export const SuppressionParams = z.object({ id: z.uuid() });

/** A mailbox `local@domain`: no spaces, no angle brackets, exactly one `@` with something either side. */
export const SuppressionAddress = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .regex(/^[^\s<>@]+@[^\s<>@]+$/, 'an address like name@example.com');

export const AddSuppressionBody = z.object({
  address: SuppressionAddress.describe('The address to refuse mail to; stored lowercased.'),
  reason: z.string().trim().min(1).max(500).describe('Why: written to the audit log and kept as the entry’s note.'),
});

export const RemoveSuppressionBody = z.object({
  reason: z.string().trim().min(1).max(500).describe('Why it may receive mail again: written to the audit log.'),
});

export const Suppression = z.object({
  id: z.uuid(),
  address: z.string().describe('Lowercased.'),
  reason: z.enum(['hard-bounce', 'manual']),
  code: z.number().int().nullable().describe('The remote reply that caused it (null for a manual add).'),
  enhanced: z.string().nullable(),
  text: z.string().nullable(),
  bounceCount: z.number().int(),
  firstAt: z.iso.datetime(),
  lastAt: z.iso.datetime(),
  note: z.string().nullable().describe('The operator’s reason, for a manual add.'),
  source: z
    .object({ recipientId: z.uuid(), outboundMessageId: z.uuid(), subject: z.string().nullable() })
    .nullable()
    .describe('The outbound recipient whose bounce caused it; null for a manual add, or once the queue row is gone.'),
});

export const SuppressionList = z.object({ suppressions: z.array(Suppression), total: z.number().int() });

/** 422 from every sending route when a recipient is suppressed (PST-REQ-179). */
export const SuppressedRefusal = z.object({
  error: z.literal('recipient_suppressed'),
  message: z.string().describe('The 550 5.1.1 reply, naming the suppression.'),
  addresses: z.array(z.string()).describe('The suppressed recipients, lowercased.'),
});

export type SuppressionJson = z.infer<typeof Suppression>;
