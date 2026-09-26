// zod validators for /api/admin/smtp (PST-T-6.3).
import { z } from 'zod';

export const ListQuery = z.object({
  daemon: z.enum(['smtp-in', 'submission']).optional(),
  clientIp: z.string().trim().min(1).max(64).optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const TranscriptIdParam = z.object({ id: z.uuid() });
