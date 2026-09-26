// zod schemas for /api/export, and the OpenAPI document's source of truth for their shapes
// (PST-REQ-085). Kept beside the route so the same objects validate requests and generate docs.
import { z } from 'zod';

export const IdParams = z.object({ id: z.string().min(1).max(200) });

export const ExportFolderManifest = z.object({
  name: z.string(),
  path: z.string(),
  messageCount: z.number().int().nonnegative(),
  sha256: z.string(),
});

export const ExportManifest = z.object({
  account: z.string(),
  exportedAt: z.iso.datetime(),
  revision: z.string(),
  schemaRevision: z.string().nullable(),
  formatVersions: z.record(z.string(), z.union([z.string(), z.number()])),
  folders: z.array(ExportFolderManifest),
  messageCount: z.number().int().nonnegative(),
  /** Extension point: a later phase's CalDAV/CardDAV export lands here. Always empty today. */
  calendars: z.array(z.unknown()),
  addressBooks: z.array(z.unknown()),
});

export const ExportStatus = z.object({
  id: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  requestedAt: z.iso.datetime(),
  error: z.string().nullable(),
  archiveSize: z.number().int().nonnegative().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  manifest: ExportManifest.nullable(),
});

export type ExportStatusJson = z.infer<typeof ExportStatus>;

export const ErrorBody = z.object({ error: z.string(), message: z.string().optional() });
