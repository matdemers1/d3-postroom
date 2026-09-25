// The Public Suffix List algorithm (https://publicsuffix.org/list/), for DMARC's organizational
// domain (RFC 7489 §3.2).
//
// The list is vendored in public_suffix_list.dat (MPL-2.0) and compiled by scripts/gen-psl.mjs into
// psl-data.ts, because tsc does not copy .dat files. Rules are stored as A-labels; input domains are
// converted with node:url's domainToASCII (UTS #46 / punycode), so IDN input and IDN rules meet in
// the same form.
//
// Section choice: by default BOTH the ICANN and PRIVATE sections apply. RFC 7489 §3.2 names "a
// public suffix list" without restricting it, and the PRIVATE section is what keeps
// alice.github.io and bob.github.io from being one organization (one could otherwise publish DMARC
// policy for, and align with, the other). `{ icannOnly: true }` is there for callers that want the
// registry-only view.

import { domainToASCII } from 'node:url';
import { ICANN_RULES, PRIVATE_RULES, PSL_VERSION } from './psl-data.js';

export { PSL_VERSION };

export interface PslOptions {
  /** Ignore the PRIVATE section (default false: the full list applies). */
  readonly icannOnly?: boolean;
}

interface RuleSet {
  /** Normal rules, e.g. "co.uk". */
  readonly exact: Set<string>;
  /** Wildcard rules by their parent: "*.ck" is stored as "ck". */
  readonly wildcard: Set<string>;
  /** Exception rules without the "!": "!www.ck" is stored as "www.ck". */
  readonly exception: Set<string>;
}

let icannSet: RuleSet | undefined;
let fullSet: RuleSet | undefined;

function addRules(set: RuleSet, text: string): void {
  for (const rule of text.split('\n')) {
    if (rule === '') continue;
    if (rule.startsWith('!')) set.exception.add(rule.slice(1));
    else if (rule.startsWith('*.')) set.wildcard.add(rule.slice(2));
    else set.exact.add(rule);
  }
}

function rules(icannOnly: boolean): RuleSet {
  if (icannOnly) {
    if (icannSet === undefined) {
      icannSet = { exact: new Set(), wildcard: new Set(), exception: new Set() };
      addRules(icannSet, ICANN_RULES);
    }
    return icannSet;
  }
  if (fullSet === undefined) {
    fullSet = { exact: new Set(), wildcard: new Set(), exception: new Set() };
    addRules(fullSet, ICANN_RULES);
    addRules(fullSet, PRIVATE_RULES);
  }
  return fullSet;
}

/**
 * A domain in the form the list is matched in: lowercase A-labels, no trailing dot. Returns
 * undefined for something that is not a usable domain name (empty labels, conversion failure).
 */
export function normalizeDomain(domain: string): string | undefined {
  let d = domain.trim().replace(/\.$/, '');
  if (d === '') return undefined;
  // eslint-disable-next-line no-control-regex -- the ASCII range is the point
  if (/^[\x00-\x7f]*$/.test(d)) d = d.toLowerCase();
  else {
    const ascii = domainToASCII(d);
    if (ascii === '') return undefined;
    d = ascii;
  }
  if (d.split('.').some((label) => label === '')) return undefined;
  return d;
}

/**
 * The public suffix of `domain` (e.g. "co.uk" for "a.b.example.co.uk"), or undefined when the
 * domain is not a usable name. Unlisted TLDs fall under the implicit "*" rule.
 */
export function publicSuffix(domain: string, options: PslOptions = {}): string | undefined {
  const d = normalizeDomain(domain);
  if (d === undefined) return undefined;
  const set = rules(options.icannOnly ?? false);
  const labels = d.split('.');
  let matched = 1; // the implicit "*" rule: one label
  for (let k = labels.length; k >= 1; k--) {
    const suffix = labels.slice(labels.length - k).join('.');
    // An exception rule wins outright; the suffix is the rule minus its leftmost label.
    if (set.exception.has(suffix)) return labels.slice(labels.length - k + 1).join('.');
    if (k > matched) {
      const parent = labels.slice(labels.length - k + 1).join('.');
      if (set.exact.has(suffix) || (k >= 2 && set.wildcard.has(parent))) matched = k;
    }
  }
  return labels.slice(labels.length - matched).join('.');
}

/**
 * The organizational domain (RFC 7489 §3.2): the public suffix plus one more label. A domain that
 * is itself a public suffix (or shorter) is its own organizational domain. Undefined when the
 * input is not a usable domain name.
 */
export function organizationalDomain(domain: string, options: PslOptions = {}): string | undefined {
  const d = normalizeDomain(domain);
  if (d === undefined) return undefined;
  const suffix = publicSuffix(d, options);
  if (suffix === undefined) return undefined;
  const labels = d.split('.');
  const suffixLabels = suffix.split('.').length;
  if (labels.length <= suffixLabels) return d;
  return labels.slice(labels.length - suffixLabels - 1).join('.');
}
