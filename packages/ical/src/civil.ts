// Proleptic-Gregorian civil-date arithmetic on plain integers (Howard Hinnant's algorithms).
// Deliberately not `Date`: `Date.UTC` maps years 0–99 to 1900–1999, and recurrence expansion does
// its arithmetic in *local wall-clock seconds* ("as if UTC"), which is exactly this.

export const SECONDS_PER_DAY = 86_400;

/** Days since 1970-01-01 for a civil date (month 1–12). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

export interface Civil {
  year: number;
  month: number;
  day: number;
}

/** Inverse of {@link daysFromCivil}. */
export function civilFromDays(days: number): Civil {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

/** ISO weekday index, 0 = Monday … 6 = Sunday. */
export function weekdayOfDays(days: number): number {
  // 1970-01-01 was a Thursday (index 3).
  return mod(days + 3, 7);
}

export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

export interface LocalParts extends Civil {
  hour: number;
  minute: number;
  second: number;
}

/** Local wall-clock seconds ("as if UTC") from parts. */
export function localSeconds(p: LocalParts): number {
  return daysFromCivil(p.year, p.month, p.day) * SECONDS_PER_DAY + p.hour * 3600 + p.minute * 60 + p.second;
}

export function partsFromLocalSeconds(s: number): LocalParts {
  const days = Math.floor(s / SECONDS_PER_DAY);
  const rem = s - days * SECONDS_PER_DAY;
  const c = civilFromDays(days);
  return { ...c, hour: Math.floor(rem / 3600), minute: Math.floor((rem % 3600) / 60), second: rem % 60 };
}
