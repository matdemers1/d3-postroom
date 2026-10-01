/**
 * One way to show a time across Settings and Admin (PST-T-17.8 pre-flight): "3 min ago", "in 4 min",
 * "Sep 24", with the full timestamp on hover and in `dateTime`. Absolute timestamps in a table are
 * noise; the exact one is one hover away.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '—';
  const delta = at - now;
  const ahead = delta > 0;
  const span = Math.abs(delta);
  const say = (n: number, unit: string) => (ahead ? `in ${n} ${unit}` : `${n} ${unit} ago`);
  if (span < 45_000) return ahead ? 'in a moment' : 'just now';
  if (span < HOUR) return say(Math.max(1, Math.round(span / MINUTE)), 'min');
  if (span < DAY) return say(Math.round(span / HOUR), 'h');
  if (span < 7 * DAY) return say(Math.round(span / DAY), Math.round(span / DAY) === 1 ? 'day' : 'days');
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fullTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function RelativeTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  if (iso === null || iso === undefined) return <span className={className}>—</span>;
  return (
    <time dateTime={iso} title={fullTime(iso)} className={className}>
      {relativeTime(iso)}
    </time>
  );
}
