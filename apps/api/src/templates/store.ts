// Compose templates: the database reads and writes behind the routes (PST-T-9.2, PST-REQ-144).
// Everything is scoped to the caller's account — a template belongs to exactly one account, never
// shared.
import type { Db, Prisma } from '@postroom/db';

type Tx = Prisma.TransactionClient;

export class TemplateError extends Error {
  constructor(public readonly code: 'not_found' | 'shortcut_taken') {
    super(code);
  }
}

export interface TemplateRow {
  id: string;
  shortcut: string;
  name: string;
  subject: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = { id: true, shortcut: true, name: true, subject: true, body: true, createdAt: true, updatedAt: true } as const;

/** Every template this account owns, by shortcut. */
export async function listTemplates(db: Db, accountId: string): Promise<TemplateRow[]> {
  return db.composeTemplate.findMany({ where: { accountId }, orderBy: { shortcut: 'asc' }, select: SELECT });
}

export async function findOwnTemplate(db: Db | Tx, accountId: string, id: string): Promise<TemplateRow | null> {
  return db.composeTemplate.findFirst({ where: { id, accountId }, select: SELECT });
}

/** P2002 (unique constraint on account_id, shortcut) reads as a named, catchable error. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

export async function createTemplate(tx: Tx, accountId: string, input: { shortcut: string; name: string; subject?: string | undefined; body: string }): Promise<TemplateRow> {
  try {
    return await tx.composeTemplate.create({
      data: { accountId, shortcut: input.shortcut, name: input.name, subject: input.subject ?? null, body: input.body },
      select: SELECT,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new TemplateError('shortcut_taken');
    throw error;
  }
}

export async function updateTemplate(
  tx: Tx,
  accountId: string,
  id: string,
  input: { shortcut: string; name: string; subject?: string | undefined; body: string },
): Promise<TemplateRow> {
  const existing = await tx.composeTemplate.findFirst({ where: { id, accountId }, select: { id: true } });
  if (existing === null) throw new TemplateError('not_found');
  try {
    return await tx.composeTemplate.update({
      where: { id },
      data: { shortcut: input.shortcut, name: input.name, subject: input.subject ?? null, body: input.body },
      select: SELECT,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new TemplateError('shortcut_taken');
    throw error;
  }
}

export async function deleteTemplate(tx: Tx, accountId: string, id: string): Promise<TemplateRow> {
  const existing = await tx.composeTemplate.findFirst({ where: { id, accountId }, select: SELECT });
  if (existing === null) throw new TemplateError('not_found');
  await tx.composeTemplate.delete({ where: { id } });
  return existing;
}
