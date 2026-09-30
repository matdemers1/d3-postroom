// A browser session's user agent, said the way a person would say it: "Chrome on macOS". The raw
// string ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/…") is unreadable in a list,
// and every browser claims to be Mozilla, so the order of the checks below is the whole trick: the
// more specific names (Edge, Opera, Firefox) come before Chrome, and Chrome before Safari, because
// each of those carries the next one's token too. Unknown parts fall back to plain words, never to
// the raw string. Pure, so it is unit-tested.

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/Edg(A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

const first = (ua: string, table: readonly (readonly [RegExp, string])[]): string | null => table.find(([re]) => re.test(ua))?.[1] ?? null;

/** "Chrome on macOS", "Safari on iPhone", "Firefox", "A browser on Linux", or "Unknown device". */
export function describeAgent(ua: string | null): string {
  if (ua === null || ua.trim() === '') return 'Unknown device';
  const browser = first(ua, BROWSERS);
  const system = first(ua, SYSTEMS);
  if (browser !== null && system !== null) return `${browser} on ${system}`;
  if (browser !== null) return browser;
  if (system !== null) return `A browser on ${system}`;
  return 'Unknown browser';
}
