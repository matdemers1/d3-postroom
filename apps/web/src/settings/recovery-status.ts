// The one line Security & devices shows about recovery codes (PST-T-16.7). Pure, for unit tests.
import type { RecoveryStatus } from '../screens/recovery/api';

const day = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

export function recoveryStatusLine(status: RecoveryStatus, formatDay: (iso: string) => string = day): string {
  if (status.total === 0) return 'You have no recovery codes. Make a set so a lost phone doesn’t lock you out.';
  if (status.remaining === 0) return `All ${String(status.total)} codes have been used. Make a new set.`;
  const made = status.createdAt === null ? '' : ` · made ${formatDay(status.createdAt)}`;
  const left = `${String(status.remaining)} of ${String(status.total)} left${made}`;
  return status.remaining <= 3 ? `${left}. Running low — make a new set soon.` : left;
}
