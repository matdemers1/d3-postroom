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

export const ErrorBody = z.object({ error: z.string(), message: z.string().optional() });

export type FilingBucketValue = z.infer<typeof FilingBucket>;
export type SenderPinViewJson = z.infer<typeof SenderPinView>;
export type SenderScreenResultJson = z.infer<typeof SenderScreenResult>;
