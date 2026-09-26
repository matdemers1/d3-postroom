// zod schemas for /api/import (PST-T-10.2, PST-REQ-152).
import { z } from 'zod';

export const IdParams = z.object({ id: z.uuid() });

/** A host name or an IP literal: no scheme, no path, no spaces. */
const Host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:[\]-]+$/, 'a host name or IP address');

export const StartImportBody = z
  .object({
    host: Host,
    port: z.number().int().min(1).max(65_535).default(993),
    username: z.string().min(1).max(320),
    password: z.string().min(1).max(1024),
    /** SHA-256 of the source's certificate, for a home server with a self-signed one. */
    trustFingerprint: z
      .string()
      .trim()
      .transform((v) => v.replace(/[\s:]/g, '').toUpperCase())
      .pipe(z.string().regex(/^[0-9A-F]{64}$/, 'a SHA-256 fingerprint'))
      .optional(),
    /** Source folder names; omitted for every folder. */
    folders: z.array(z.string().min(1).max(1000)).min(1).max(500).optional(),
  })
  .strict();

export const ImportFolderStatus = z.object({
  name: z.string(),
  target: z.string(),
  total: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  done: z.boolean(),
});

export const ImportStatusBody = z.object({
  id: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled']),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  pinned: z.boolean(),
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  cancelRequested: z.boolean(),
  folders: z.array(ImportFolderStatus),
  totals: z.object({
    folders: z.number().int().nonnegative(),
    foldersDone: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    imported: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
  }),
});

export type ImportStatusJson = z.infer<typeof ImportStatusBody>;
