import type { AuditEvent, Db } from '@postroom/db';

export interface ListAuditOptions {
  readonly entityType?: string;
  readonly entityId?: string;
  readonly actorAccountId?: string;
  readonly limit?: number;
  /** Opaque cursor from a previous page's last row: `${id}:${at.toISOString()}`. */
  readonly cursor?: string;
}

export interface ListAuditPage {
  readonly rows: AuditEvent[];
  readonly nextCursor: string | null;
}

function encodeCursor(row: AuditEvent): string {
  return `${row.id}:${row.at.toISOString()}`;
}

function decodeCursor(cursor: string): { id: string; at: Date } {
  const sep = cursor.indexOf(':');
  const id = cursor.slice(0, sep);
  const at = new Date(cursor.slice(sep + 1));
  return { id, at };
}

/** Newest-first page of audit events, for the admin screen. */
export async function listAudit(db: Db, opts: ListAuditOptions = {}): Promise<ListAuditPage> {
  const limit = opts.limit ?? 50;
  const where: Record<string, unknown> = {};
  if (opts.entityType !== undefined) where['entityType'] = opts.entityType;
  if (opts.entityId !== undefined) where['entityId'] = opts.entityId;
  if (opts.actorAccountId !== undefined) where['actorAccountId'] = opts.actorAccountId;

  let cursorFilter: Record<string, unknown> = {};
  if (opts.cursor !== undefined) {
    const { id, at } = decodeCursor(opts.cursor);
    cursorFilter = {
      OR: [{ at: { lt: at } }, { at, id: { lt: id } }],
    };
  }

  const rows = await db.auditEvent.findMany({
    where: { ...where, ...cursorFilter },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1] as AuditEvent) : null;
  return { rows: page, nextCursor };
}
