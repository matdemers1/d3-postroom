// Sender pins and the new-sender screen over HTTP (PST-T-5.4, PST-REQ-105, PST-REQ-106). The same
// objects the OpenAPI document is generated from (PST-REQ-085).
import { FILING_BUCKETS } from '@postroom/classifier';
import { z } from 'zod';

/** A raw email address, as it would appear in a From header (loosely: something@something). */
export const AddressParam = z.object({ address: z.string().trim().min(3).max(320).regex(/^[^\s@]+@[^\s@]+$/, 'must look like an email address') });

export const FilingBucket = z.enum(FILING_BUCKETS);

export const SenderPinBody = z.object({ bucket: FilingBucket });

export const SenderScreenBody = z.object({ decision: z.enum(['allow', 'block']) });

export const SenderPinView = z.object({
  address: z.string(),
  /** The pinned bucket, or null when this sender has no pin (it may still have a screen decision). */
  bucket: FilingBucket.nullable(),
});

export const SenderScreenResult = z.object({
  ok: z.literal(true),
  address: z.string(),
  decision: z.enum(['allow', 'block']),
  /** How many of this sender's already-filed messages had their new-sender badge cleared. */
  clearedNewSender: z.number().int(),
});

// --- Sender profile (PST-T-5.6, PST-REQ-113) ----------------------------------------------------

export const SenderProfileMessage = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  date: z.string(),
  bucket: FilingBucket.nullable(),
});

export const UnsubscribeStatus = z.object({
  attempted: z.boolean(),
  at: z.string().nullable(),
  method: z.string().nullable(),
  result: z.string().nullable(),
  detail: z.string().nullable(),
});

export const SenderAuth = z.object({
  dkimDomains: z.array(z.string()),
  sampleSize: z.number().int(),
  dkimPassRate: z.number().nullable(),
  spfPassRate: z.number().nullable(),
  dmarcPassRate: z.number().nullable(),
});

export const SenderProfile = z.object({
  address: z.string(),
  messageCount: z.number().int(),
  firstSeenAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  buckets: z.array(z.object({ bucket: z.string(), count: z.number().int() })),
  recentMessages: z.array(SenderProfileMessage),
  pin: FilingBucket.nullable(),
  screen: z.enum(['allow', 'block']).nullable(),
  unsubscribe: UnsubscribeStatus,
  auth: SenderAuth,
  wroteTo: z.array(z.string()),
});

// --- Unsubscribe (PST-T-5.6, PST-REQ-110) -------------------------------------------------------

export const MessageIdParams = z.object({ id: z.uuid() });

export const UnsubscribeResult = z.object({
  ok: z.boolean(),
  /** Why it was refused, or the last upstream status text — never empty. */
  detail: z.string(),
  /** True when the message offered RFC 8058 One-Click at all (independent of whether it succeeded). */
  offered: z.boolean(),
  /** A mailto: unsubscribe link, when the message carried one — shown, never sent automatically. */
  mailto: z.string().nullable(),
});

export const ErrorBody = z.object({ error: z.string(), message: z.string().optional() });

export type FilingBucketValue = z.infer<typeof FilingBucket>;
export type SenderPinViewJson = z.infer<typeof SenderPinView>;
export type SenderScreenResultJson = z.infer<typeof SenderScreenResult>;
export type SenderProfileJsonSchema = z.infer<typeof SenderProfile>;
export type UnsubscribeResultJson = z.infer<typeof UnsubscribeResult>;
