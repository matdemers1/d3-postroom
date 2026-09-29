// Sorting corrections over HTTP (PST-T-14.9, PST-ADR-011): a correction is a move plus a recorded
// sender preference, audited and undoable. The same zod objects the OpenAPI document is generated
// from (PST-REQ-085).
import { FILING_BUCKETS } from '@postroom/classifier';
import { z } from 'zod';
import { MessageSummary } from '../mail/schemas.js';

export const CorrectionBody = z.object({
  messageId: z.uuid().describe('The message the correction is made on.'),
  bucket: z.enum(FILING_BUCKETS).describe('Where the message — and, from now on, this sender’s new mail — belongs.'),
  scope: z
    .enum(['sender', 'domain'])
    .default('sender')
    .describe('Record the preference on the From address, or on its whole domain ("Always put github.com in Notifications"). A domain preference is refused for Priority/People and for mailbox providers.'),
  source: z.enum(['chip', 'card']).default('chip').describe('Where the correction was made: the bucket chip’s popover, or the Person card.'),
});

export const CorrectionIdParams = z.object({ id: z.uuid() });

export const SortingCorrection = z.object({
  id: z.uuid(),
  scope: z.enum(['sender', 'domain']),
  /** The preference's key: a normalized address, or "@domain". */
  target: z.string(),
  fromBucket: z.string().nullable(),
  toBucket: z.string(),
  /** The corrected message's id after the move; null when it is gone. */
  messageId: z.uuid().nullable(),
  /** True when the correction moved the message (false for "Always put … in" its current bucket). */
  moved: z.boolean(),
  subject: z.string().nullable(),
  fromAddress: z.string().nullable(),
  source: z.enum(['chip', 'card']),
  createdAt: z.iso.datetime(),
  undoneAt: z.iso.datetime().nullable(),
});

export const CorrectionResult = z.object({
  correction: SortingCorrection,
  /** The corrected message as it is now (in its new mailbox, under its new id). */
  message: MessageSummary,
});

export const CorrectionList = z.object({ corrections: z.array(SortingCorrection) });

export const UndoResult = z.object({
  correction: SortingCorrection,
  /** True when the message was moved back where it came from. */
  movedBack: z.boolean(),
  /** The message, back where it was; null when it had moved on or gone and was left alone. */
  message: MessageSummary.nullable(),
  /** True when the sender preference was put back as it was before the correction. */
  preferenceRestored: z.boolean(),
});

export type CorrectionBodyInput = z.infer<typeof CorrectionBody>;
export type SortingCorrectionJson = z.infer<typeof SortingCorrection>;
export type CorrectionResultJson = z.infer<typeof CorrectionResult>;
export type UndoResultJson = z.infer<typeof UndoResult>;
