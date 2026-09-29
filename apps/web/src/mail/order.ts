// PST-T-14.10: the one ordering of a message list — newest first by internal date (arrival), ties
// by UID descending, then by id. The API pages in exactly this order: message.internal_date is
// millisecond precision (timestamptz(3)), the same value a summary's internalDate carries, so this
// comparator and the server's ORDER BY internal_date DESC, uid DESC agree by construction. Not by
// UID alone: a move gives a message a new UID but keeps its internal date, so a message archived
// and brought back by Undo returns to its place rather than to the top.
//
// No imports on purpose: apps/api's integration test sorts a real page with this very function.

export interface Ordered {
  readonly internalDate: string;
  readonly uid: number;
  readonly id: string;
}

export function newestFirst(a: Ordered, b: Ordered): number {
  const at = Date.parse(a.internalDate);
  const bt = Date.parse(b.internalDate);
  if (at !== bt) return bt - at;
  if (a.uid !== b.uid) return b.uid - a.uid;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** True when `m` would sort above every listed row, pushing them all down (never for an empty list). */
export function sortsAboveTop(m: Ordered, listed: readonly Ordered[]): boolean {
  return listed.length > 0 && listed.every((x) => x.id !== m.id && newestFirst(m, x) < 0);
}
