// PST-T-17.11: how Import says where an import stands — a dot and a word (D-016: neutral while it
// is fine, colour only when it needs you). Pure, so the words and tones are tested without rendering.
import type { ImportFolderStatus, ImportStatus } from '../../api';

export type Tone = 'neutral' | 'attention' | 'danger' | 'idle';

export const ACTIVE_STATUSES: ReadonlySet<ImportStatus['status']> = new Set(['pending', 'running']);

const STATUS_LABEL: Record<ImportStatus['status'], string> = {
  pending: 'Waiting to start',
  running: 'Importing',
  done: 'Finished',
  failed: 'Failed',
  cancelled: 'Canceled',
};

export function isActive(imp: Pick<ImportStatus, 'status'> | null | undefined): boolean {
  return imp !== null && imp !== undefined && ACTIVE_STATUSES.has(imp.status);
}

/** The import's state. An active import that hit an error is resuming: that wants your attention. */
export function importState(imp: Pick<ImportStatus, 'status' | 'error'>): { tone: Tone; label: string } {
  if (imp.status === 'failed') return { tone: 'danger', label: STATUS_LABEL.failed };
  if (ACTIVE_STATUSES.has(imp.status) && imp.error !== null) return { tone: 'attention', label: 'Interrupted, resuming' };
  if (imp.status === 'cancelled') return { tone: 'idle', label: STATUS_LABEL.cancelled };
  return { tone: 'neutral', label: STATUS_LABEL[imp.status] };
}

/** The card's title: what it is now, not who it was for (that is the description). */
export function importTitle(imp: Pick<ImportStatus, 'status'>): string {
  return isActive(imp) ? 'Import in progress' : 'Last import';
}

/** One folder's state: done, still to come while the import runs, or left behind when it ended. */
export function folderState(f: Pick<ImportFolderStatus, 'done'>, imp: Pick<ImportStatus, 'status'>): { tone: Tone; label: string } {
  if (f.done) return { tone: 'neutral', label: 'Done' };
  return isActive(imp) ? { tone: 'idle', label: 'Waiting' } : { tone: 'idle', label: 'Not finished' };
}

/** "12 of 40", with duplicates when there were any. */
export function folderCount(f: Pick<ImportFolderStatus, 'imported' | 'duplicates' | 'total'>): string {
  const handled = f.imported + f.duplicates;
  return `${String(handled)} of ${String(f.total)}${f.duplicates > 0 ? ` (${String(f.duplicates)} already here)` : ''}`;
}

/** Why the form cannot be sent yet, or null. The step-up code is not the form's: it is asked in a
 *  modal when the import starts. */
export function importFormProblem(input: { host: string; port: string; username: string; password: string }): string | null {
  if (input.host.trim() === '' || input.username.trim() === '' || input.password === '') return 'Enter the server, your username there, and its password.';
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'The port is a number from 1 to 65535 (usually 993).';
  return null;
}
