// Spamhaus ZEN return-code mapping (https://www.spamhaus.org/zen/): 127.0.0.2/.3 SBL,
// 127.0.0.4-.7 XBL, 127.0.0.9 DROP, 127.0.0.10/.11 PBL. The 127.255.255.x range is Spamhaus
// signalling a problem with how we asked (typo, public resolver, rate limit) — never a listing.
export type SpamhausList = 'SBL' | 'SBL CSS' | 'XBL' | 'DROP' | 'PBL';

const LIST_BY_CODE: Readonly<Record<string, SpamhausList>> = {
  '127.0.0.2': 'SBL',
  '127.0.0.3': 'SBL CSS',
  '127.0.0.4': 'XBL',
  '127.0.0.5': 'XBL',
  '127.0.0.6': 'XBL',
  '127.0.0.7': 'XBL',
  '127.0.0.9': 'DROP',
  '127.0.0.10': 'PBL',
  '127.0.0.11': 'PBL',
};

/** Lists that are a reason to reject at the MX. PBL alone is a policy signal, not a listing —
 * it names dynamic/end-user ranges that should not be sending direct-to-MX at all, but plenty of
 * legitimate outbound relays sit behind PBL-listed space, so we record it and do not reject on it. */
const REJECT_LISTS: ReadonlySet<SpamhausList> = new Set(['SBL', 'SBL CSS', 'XBL', 'DROP']);

/** Spamhaus's own explanation for each 127.255.255.x signalling code. */
export const DNSBL_ERROR_CODES: Readonly<Record<string, string>> = {
  '127.255.255.252': 'Spamhaus reports a malformed query (zone or key typo)',
  '127.255.255.254': 'Spamhaus reports this query came through a public/open resolver',
  '127.255.255.255': 'Spamhaus reports excessive queries from this resolver (rate limited)',
};

export function listForCode(code: string): SpamhausList | undefined {
  return LIST_BY_CODE[code];
}

export function isErrorCode(code: string): code is keyof typeof DNSBL_ERROR_CODES {
  return code in DNSBL_ERROR_CODES;
}

export function shouldReject(lists: readonly SpamhausList[]): boolean {
  return lists.some((l) => REJECT_LISTS.has(l));
}
