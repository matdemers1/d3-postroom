// The webmail's Sieve routes (PST-T-9.5, PST-REQ-150): request validators and response shapes, the
// same objects the OpenAPI document is generated from (PST-REQ-085).
import { z } from 'zod';

export const ScriptNameParam = z.object({ name: z.string().min(1).max(512).describe('The script name (URL-encoded).') });

export const ScriptBody = z.object({ content: z.string().max(1024 * 1024) });

export const ScriptSummary = z.object({
  name: z.string(),
  active: z.boolean(),
  /** UTF-8 octets. */
  size: z.number().int(),
  updatedAt: z.string(),
});

export const ScriptList = z.object({
  scripts: z.array(ScriptSummary),
  /** The Sieve extensions scripts may require. */
  extensions: z.array(z.string()),
  maxScripts: z.number().int(),
  maxScriptBytes: z.number().int(),
});

export const ScriptDetail = ScriptSummary.extend({ content: z.string() });

/** A compile error, with where it is (1-based line and column). */
export const CompileError = z.object({ line: z.number().int(), column: z.number().int(), message: z.string() });

export const CheckResult = z.object({ valid: z.boolean(), error: CompileError.nullable() });

export const ScriptRefusal = z.object({ error: z.string(), message: z.string(), compileError: CompileError.optional() });

export const OkBody = z.object({ ok: z.literal(true) });

export type ScriptSummaryJson = z.infer<typeof ScriptSummary>;
export type ScriptListJson = z.infer<typeof ScriptList>;
export type ScriptDetailJson = z.infer<typeof ScriptDetail>;
export type CheckResultJson = z.infer<typeof CheckResult>;
