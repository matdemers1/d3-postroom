// Masked aliases over HTTP (PST-T-5.7, PST-REQ-112). The same objects the OpenAPI document is
// generated from (PST-REQ-085).
import { z } from 'zod';

export const CreateAliasBody = z.object({
  site: z.string().trim().min(1).max(200),
});

export const AliasIdParam = z.object({
  id: z.uuid(),
});

export const AliasView = z.object({
  id: z.uuid(),
  address: z.string(),
  site: z.string(),
  createdAt: z.iso.datetime(),
  killedAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  receivedCount: z.number().int(),
});

export const AliasCreated = z.object({
  alias: AliasView,
});

export const AliasList = z.object({
  aliases: z.array(AliasView),
});

export type AliasViewJson = z.infer<typeof AliasView>;
export type CreateAliasBodyJson = z.infer<typeof CreateAliasBody>;
