// The Sieve script store (PST-T-9.5): the one place scripts are written, shared by the ManageSieve
// daemon (RFC 5804, PST-REQ-149) and the webmail's rules API (apps/api/src/sieve, PST-REQ-150), so
// both enforce the same rules:
//
//   · a script is stored only if it compiles with @postroom/sieve — a compile error is refused with
//     its line and column, never stored (RFC 5804 §2.6: PUTSCRIPT checks the script);
//   · at most one script per account is active (a partial unique index backs this up);
//   · the active script cannot be deleted (RFC 5804 §2.10: NO (ACTIVE));
//   · a name is 1-128 characters without control characters (RFC 5804 §1.6), a script is at most
//     MAX_SCRIPT_BYTES of UTF-8, and an account has at most MAX_SCRIPTS scripts;
//   · every mutation is audited in the same transaction (PST-REQ-009).
//
// Writes for one account are serialised by an advisory lock, so the count check and the active flag
// cannot race another session's write.
import { audited, type RequestContext } from '@postroom/audit';
import type { Db, Prisma } from '@postroom/db';
import { compileScript, DEFAULT_LIMITS, SieveSyntaxError, SUPPORTED_EXTENSIONS } from '@postroom/sieve';

type Tx = Prisma.TransactionClient;

/** Largest script, in UTF-8 octets: the Sieve parser's own limit. */
export const MAX_SCRIPT_BYTES: number = DEFAULT_LIMITS.maxScriptBytes;
export const MAX_SCRIPTS = 32;
export const MAX_NAME_LENGTH = 128;
/** Distinct redirects a script may make at run time (the interpreter's default). */
export const MAX_REDIRECTS = 4;
/** The SIEVE capability: every extension the interpreter supports, space-separated (RFC 5804 §1.7). */
export const SIEVE_EXTENSIONS: string = SUPPORTED_EXTENSIONS.join(' ');

export type SieveStoreErrorCode = 'nonexistent' | 'already-exists' | 'active' | 'invalid-name' | 'too-many-scripts' | 'too-large' | 'invalid-script';

export interface CompileProblem {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export class SieveStoreError extends Error {
  override readonly name = 'SieveStoreError';
  constructor(
    readonly code: SieveStoreErrorCode,
    message: string,
    readonly problem: CompileProblem | null = null,
  ) {
    super(message);
  }
}

export interface ScriptSummary {
  readonly name: string;
  readonly active: boolean;
  /** UTF-8 octets. */
  readonly size: number;
  readonly updatedAt: Date;
}

export interface Script extends ScriptSummary {
  readonly content: string;
}

/** Who is writing, for the audit row. */
export interface StoreActor {
  readonly accountId: string;
  readonly context: RequestContext;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Why a name is not acceptable, or null when it is. */
export function invalidNameReason(name: string): string | null {
  if (name.length === 0) return 'a script name cannot be empty';
  if (Array.from(name).length > MAX_NAME_LENGTH) return `a script name is at most ${MAX_NAME_LENGTH} characters`;
  // RFC 5804 §1.6: no control characters (0000-001F, 007F-009F), no line or paragraph separators.
  if (CONTROL.test(name)) return 'a script name cannot contain control characters';
  return null;
}

/** Compile without storing: null when the script is valid (RFC 5804 CHECKSCRIPT). */
export function checkScript(content: string): CompileProblem | null {
  if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) {
    return { line: 1, column: 1, message: `script is larger than ${MAX_SCRIPT_BYTES} octets` };
  }
  try {
    compileScript(content);
    return null;
  } catch (err) {
    if (err instanceof SieveSyntaxError) return { line: err.line, column: err.column, message: err.message };
    throw err;
  }
}

function summary(row: { name: string; active: boolean; content: string; updatedAt: Date }): ScriptSummary {
  return { name: row.name, active: row.active, size: Buffer.byteLength(row.content, 'utf8'), updatedAt: row.updatedAt };
}

async function lockAccount(tx: Tx, accountId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'postroom-sieve:' + accountId}, 0))`;
}

function requireName(name: string): void {
  const reason = invalidNameReason(name);
  if (reason !== null) throw new SieveStoreError('invalid-name', reason);
}

export async function listScripts(db: Db | Tx, accountId: string): Promise<ScriptSummary[]> {
  const rows = await db.sieveScript.findMany({ where: { accountId }, orderBy: { name: 'asc' }, select: { name: true, active: true, content: true, updatedAt: true } });
  return rows.map(summary);
}

export async function getScript(db: Db | Tx, accountId: string, name: string): Promise<Script | null> {
  const row = await db.sieveScript.findUnique({ where: { accountId_name: { accountId, name } }, select: { name: true, active: true, content: true, updatedAt: true } });
  return row === null ? null : { ...summary(row), content: row.content };
}

/**
 * RFC 5804 HAVESPACE: would a script of `size` octets named `name` fit? Null when it would; the
 * error otherwise (too-large or too-many-scripts). Replacing an existing script never adds one.
 */
export async function haveSpace(db: Db | Tx, accountId: string, name: string, size: number): Promise<SieveStoreError | null> {
  requireName(name);
  if (size > MAX_SCRIPT_BYTES) return new SieveStoreError('too-large', `a script is at most ${MAX_SCRIPT_BYTES} octets`);
  const [count, existing] = await Promise.all([
    db.sieveScript.count({ where: { accountId } }),
    db.sieveScript.findUnique({ where: { accountId_name: { accountId, name } }, select: { id: true } }),
  ]);
  if (existing === null && count >= MAX_SCRIPTS) return new SieveStoreError('too-many-scripts', `an account has at most ${MAX_SCRIPTS} scripts`);
  return null;
}

/** Create or replace a script (RFC 5804 PUTSCRIPT). Compiles first; an active script stays active. */
export async function putScript(db: Db, actor: StoreActor, name: string, content: string): Promise<ScriptSummary> {
  requireName(name);
  if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) throw new SieveStoreError('too-large', `a script is at most ${MAX_SCRIPT_BYTES} octets`);
  const problem = checkScript(content);
  if (problem !== null) throw new SieveStoreError('invalid-script', problem.message, problem);
  const { accountId } = actor;
  return audited(db, { kind: 'account', accountId }, { action: 'sieve.script.put', entityType: 'sieve_script', context: actor.context }, async (tx) => {
    await lockAccount(tx, accountId);
    const existing = await tx.sieveScript.findUnique({ where: { accountId_name: { accountId, name } }, select: { id: true, content: true, active: true } });
    if (existing === null && (await tx.sieveScript.count({ where: { accountId } })) >= MAX_SCRIPTS) {
      throw new SieveStoreError('too-many-scripts', `an account has at most ${MAX_SCRIPTS} scripts`);
    }
    const row =
      existing === null
        ? await tx.sieveScript.create({ data: { accountId, name, content }, select: { id: true, name: true, active: true, content: true, updatedAt: true } })
        : await tx.sieveScript.update({ where: { id: existing.id }, data: { content }, select: { id: true, name: true, active: true, content: true, updatedAt: true } });
    const out = summary(row);
    return {
      entityId: row.id,
      before: existing === null ? null : { name, size: Buffer.byteLength(existing.content, 'utf8'), active: existing.active },
      after: { name, size: out.size, active: out.active },
      result: out,
    };
  });
}

/** RFC 5804 SETACTIVE: make `name` the one active script, or deactivate every script with "". */
export async function setActive(db: Db, actor: StoreActor, name: string): Promise<void> {
  const { accountId } = actor;
  await audited(
    db,
    { kind: 'account', accountId },
    { action: name === '' ? 'sieve.script.deactivate' : 'sieve.script.activate', entityType: 'sieve_script', context: actor.context },
    async (tx) => {
      await lockAccount(tx, accountId);
      const previous = await tx.sieveScript.findFirst({ where: { accountId, active: true }, select: { id: true, name: true } });
      let target: { id: string } | null = null;
      if (name !== '') {
        target = await tx.sieveScript.findUnique({ where: { accountId_name: { accountId, name } }, select: { id: true } });
        if (target === null) throw new SieveStoreError('nonexistent', `there is no script named "${name}"`);
      }
      // Clear first, then set: the partial unique index allows one active row at any instant.
      await tx.sieveScript.updateMany({ where: { accountId, active: true, ...(target === null ? {} : { id: { not: target.id } }) }, data: { active: false } });
      if (target !== null) await tx.sieveScript.update({ where: { id: target.id }, data: { active: true } });
      return { entityId: target?.id ?? previous?.id ?? null, before: { active: previous?.name ?? null }, after: { active: name === '' ? null : name }, result: undefined };
    },
  );
}

/** RFC 5804 DELETESCRIPT. The active script is refused (ACTIVE). */
export async function deleteScript(db: Db, actor: StoreActor, name: string): Promise<void> {
  const { accountId } = actor;
  await audited(db, { kind: 'account', accountId }, { action: 'sieve.script.delete', entityType: 'sieve_script', context: actor.context }, async (tx) => {
    await lockAccount(tx, accountId);
    const row = await tx.sieveScript.findUnique({ where: { accountId_name: { accountId, name } }, select: { id: true, active: true, content: true } });
    if (row === null) throw new SieveStoreError('nonexistent', `there is no script named "${name}"`);
    if (row.active) throw new SieveStoreError('active', 'the active script cannot be deleted; deactivate it first');
    await tx.sieveScript.delete({ where: { id: row.id } });
    return { entityId: row.id, before: { name, size: Buffer.byteLength(row.content, 'utf8') }, after: null, result: undefined };
  });
}

/** RFC 5804 RENAMESCRIPT. An active script stays active under its new name. */
export async function renameScript(db: Db, actor: StoreActor, oldName: string, newName: string): Promise<void> {
  requireName(newName);
  const { accountId } = actor;
  await audited(db, { kind: 'account', accountId }, { action: 'sieve.script.rename', entityType: 'sieve_script', context: actor.context }, async (tx) => {
    await lockAccount(tx, accountId);
    const row = await tx.sieveScript.findUnique({ where: { accountId_name: { accountId, name: oldName } }, select: { id: true } });
    if (row === null) throw new SieveStoreError('nonexistent', `there is no script named "${oldName}"`);
    if (oldName !== newName) {
      const clash = await tx.sieveScript.findUnique({ where: { accountId_name: { accountId, name: newName } }, select: { id: true } });
      if (clash !== null) throw new SieveStoreError('already-exists', `a script named "${newName}" already exists`);
      await tx.sieveScript.update({ where: { id: row.id }, data: { name: newName } });
    }
    return { entityId: row.id, before: { name: oldName }, after: { name: newName }, result: undefined };
  });
}
