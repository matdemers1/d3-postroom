// Small pure formatter for the app-passwords screen (PST-T-10.3 / PST-REQ-153). Kept out of
// AppPasswords.tsx so it can be unit-tested without pulling in @d3cloud/ui's CSS.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const absolute = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * "Just now" / "12 minutes ago" / "3 hours ago" / "5 days ago" for anything within the last month;
 * an absolute date beyond that, so a password nobody has used in a year does not claim "days ago".
 */
export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return 'Never';
  const then = new Date(iso);
  const deltaMs = now.getTime() - then.getTime();
  if (deltaMs < 0 || deltaMs < MINUTE) return 'Just now';
  if (deltaMs < HOUR) {
    const minutes = Math.floor(deltaMs / MINUTE);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (deltaMs < DAY) {
    const hours = Math.floor(deltaMs / HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (deltaMs < 30 * DAY) {
    const days = Math.floor(deltaMs / DAY);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return absolute(iso);
}
