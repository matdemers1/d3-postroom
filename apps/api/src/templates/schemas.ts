// Compose templates over HTTP (PST-T-9.2, PST-REQ-144). The same objects the OpenAPI document is
// generated from (PST-REQ-085).
import { z } from 'zod';

const Shortcut = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\s;]+$/, 'no whitespace or ";"')
  .describe('What ; matches on in the composer, unique per account (without the leading ;).');
const Name = z.string().trim().min(1).max(200);
const Subject = z.string().max(998).optional();
const Body = z.string().max(1_000_000).describe('Markdown, with {{variables}}.');

export const CreateTemplateBody = z.object({
  shortcut: Shortcut,
  name: Name,
  subject: Subject,
  body: Body,
});

export const UpdateTemplateBody = z.object({
  shortcut: Shortcut,
  name: Name,
  subject: Subject,
  body: Body,
});

export const TemplateIdParam = z.object({ id: z.uuid() });

export const Template = z.object({
  id: z.uuid(),
  shortcut: z.string(),
  name: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const TemplateList = z.object({ templates: z.array(Template) });
export const TemplateCreated = z.object({ template: Template });

export type TemplateJson = z.infer<typeof Template>;
export type CreateTemplateBodyJson = z.infer<typeof CreateTemplateBody>;
export type UpdateTemplateBodyJson = z.infer<typeof UpdateTemplateBody>;
