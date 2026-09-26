// The DMARC policy record (RFC 7489 §6.3, §6.6.3; np= from RFC 9091).
//
// Parsing never throws: a record either parses (possibly with notes about tags it ignored or
// defaulted) or is rejected with the reason. Unknown tags are ignored (§6.3); a syntax error in an
// optional tag falls back to that tag's default, with a note.

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';
export type DmarcAlignmentMode = 'r' | 's';

export interface DmarcRecord {
  /** The TXT value as published. */
  readonly raw: string;
  /** p=: the policy for the domain the record was found at. */
  readonly p: DmarcPolicy;
  /** sp=: the policy for subdomains of the organizational domain, when published. */
  readonly sp?: DmarcPolicy;
  /** np=: the policy for non-existent subdomains (RFC 9091), when published. */
  readonly np?: DmarcPolicy;
  readonly adkim: DmarcAlignmentMode;
  readonly aspf: DmarcAlignmentMode;
  /** pct=: percentage of failing messages the policy applies to (0–100). */
  readonly pct: number;
  readonly rua: readonly string[];
  readonly ruf: readonly string[];
  readonly fo: readonly string[];
  readonly rf: readonly string[];
  readonly ri: number;
  /**
   * p= (or sp=) was missing or invalid and a valid rua= was present, so the record is treated as
   * p=none (RFC 7489 §6.6.3 step 6).
   */
  readonly pAssumed: boolean;
  /** Tags that were ignored, defaulted or duplicated. */
  readonly notes: readonly string[];
}

export type DmarcRecordParse =
  | { readonly ok: true; readonly record: DmarcRecord }
  /** `isDmarc` false: not a DMARC record at all (discarded silently in discovery). */
  | { readonly ok: false; readonly isDmarc: boolean; readonly reason: string };

const POLICIES: readonly string[] = ['none', 'quarantine', 'reject'];
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

function isPolicy(v: string | undefined): v is DmarcPolicy {
  return v !== undefined && POLICIES.includes(v);
}

function list(value: string | undefined, sep: string): string[] {
  if (value === undefined) return [];
  return value
    .split(sep)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Parse one TXT value found at _dmarc.<domain>. */
export function parseDmarcRecord(txt: string): DmarcRecordParse {
  const parts = txt
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const first = parts[0];
  const firstEq = first?.indexOf('=') ?? -1;
  // §6.4: the record must start with v=DMARC1, which "MUST match precisely".
  if (first === undefined || firstEq === -1 || first.slice(0, firstEq).trim() !== 'v' || first.slice(firstEq + 1).trim() !== 'DMARC1') {
    return { ok: false, isDmarc: false, reason: 'not a DMARC record (does not start with v=DMARC1)' };
  }

  const notes: string[] = [];
  const tags = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      notes.push(`ignored malformed tag "${part}"`);
      continue;
    }
    const name = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (tags.has(name)) {
      notes.push(`ignored duplicate ${name}= tag`);
      continue;
    }
    tags.set(name, value);
  }
  const lower = (name: string): string | undefined => tags.get(name)?.toLowerCase();

  const rua = list(tags.get('rua'), ',');
  const ruf = list(tags.get('ruf'), ',');
  const hasValidRua = rua.some((u) => URI.test(u.replace(/!\d+[kmgt]?$/i, '')));

  const pRaw = lower('p');
  const spRaw = lower('sp');
  let p: DmarcPolicy;
  let sp: DmarcPolicy | undefined;
  let pAssumed = false;
  const pBad = !isPolicy(pRaw);
  const spBad = spRaw !== undefined && !isPolicy(spRaw);
  if (pBad || spBad) {
    const what = pBad ? (pRaw === undefined ? 'no p= tag' : `invalid p=${pRaw}`) : `invalid sp=${spRaw ?? ''}`;
    if (!hasValidRua) {
      return { ok: false, isDmarc: true, reason: `DMARC record has ${what} and no valid rua=; DMARC is not applied (RFC 7489 §6.6.3)` };
    }
    p = 'none';
    sp = undefined;
    pAssumed = true;
    notes.push(`record has ${what} but a valid rua=: treated as p=none (RFC 7489 §6.6.3)`);
  } else {
    p = pRaw;
    sp = isPolicy(spRaw) ? spRaw : undefined;
  }

  const npRaw = lower('np');
  let np: DmarcPolicy | undefined;
  if (npRaw !== undefined) {
    if (isPolicy(npRaw) && !pAssumed) np = npRaw;
    else if (!isPolicy(npRaw)) notes.push(`ignored invalid np=${npRaw}`);
  }

  const mode = (name: 'adkim' | 'aspf'): DmarcAlignmentMode => {
    const v = lower(name);
    if (v === undefined || v === 'r') return 'r';
    if (v === 's') return 's';
    notes.push(`ignored invalid ${name}=${v}; using relaxed`);
    return 'r';
  };
  const adkim = mode('adkim');
  const aspf = mode('aspf');

  let pct = 100;
  const pctRaw = tags.get('pct');
  if (pctRaw !== undefined) {
    if (/^\d{1,3}$/.test(pctRaw) && Number(pctRaw) <= 100) pct = Number(pctRaw);
    else notes.push(`ignored invalid pct=${pctRaw}; using 100`);
  }

  let ri = 86400;
  const riRaw = tags.get('ri');
  if (riRaw !== undefined) {
    if (/^\d{1,10}$/.test(riRaw)) ri = Number(riRaw);
    else notes.push(`ignored invalid ri=${riRaw}`);
  }

  return {
    ok: true,
    record: {
      raw: txt,
      p,
      ...(sp === undefined ? {} : { sp }),
      ...(np === undefined ? {} : { np }),
      adkim,
      aspf,
      pct,
      rua,
      ruf,
      fo: list(tags.get('fo') ?? '0', ':'),
      rf: list(tags.get('rf') ?? 'afrf', ':'),
      ri,
      pAssumed,
      notes,
    },
  };
}
