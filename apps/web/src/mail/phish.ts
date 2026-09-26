// Pure logic behind ReadingPane's phishing/lookalike warning banner (PST-T-6.5, PST-REQ-120).
// Kept apart from ReadingPane.tsx (which imports @d3cloud/ui, and so its CSS) so this can be unit
// tested directly under Node, the same way format.ts/list.ts/keys.ts are.
import type { PhishWarning } from '../api';

const SEVERITY_RANK: Record<PhishWarning['severity'], number> = { high: 0, medium: 1, low: 2 };

/** Highest severity first; stable among warnings of the same severity. */
export function sortPhishWarnings(warnings: readonly PhishWarning[]): PhishWarning[] {
  return warnings
    .map((w, index) => ({ w, index }))
    .sort((a, b) => SEVERITY_RANK[a.w.severity] - SEVERITY_RANK[b.w.severity] || a.index - b.index)
    .map(({ w }) => w);
}

const KIND_TITLE: Record<PhishWarning['kind'], string> = {
  'display-name-spoofing': 'Display name does not match the sender',
  'lookalike-domain': 'Lookalike domain',
  'punycode-domain': 'Internationalized domain',
  'first-time-brand-sender': 'First message from this address',
  'auth-failure': 'Authentication failed',
  'link-mismatch': 'A link goes somewhere unexpected',
};

/**
 * The heading shown above a warning's reason — a short label, never a substitute for the reason
 * itself. An auth failure is one kind for three different checks, so with its reason the title
 * names the check (PST-T-11.4): two cards both titled "Authentication failed" said nothing.
 */
export function phishWarningTitle(kind: PhishWarning['kind'], reason?: string): string {
  if (kind === 'auth-failure' && reason !== undefined) {
    if (/^DMARC failed/.test(reason)) return 'DMARC check failed';
    if (/publishes DMARC/.test(reason)) return 'No DMARC result for a protected domain';
    if (/^SPF failed/.test(reason)) return 'SPF check failed';
    if (/^DKIM/.test(reason)) return 'DKIM signature did not pass';
  }
  return KIND_TITLE[kind];
}

/** The one-line verdict above the warnings, by the worst severity present (sorted worst first). */
export function phishVerdict(sorted: readonly Pick<PhishWarning, 'severity'>[]): string {
  const worst = sorted[0]?.severity;
  if (worst === 'high') return 'This message may be a phishing attempt. Do not reply, open links or download attachments unless you are sure who sent it.';
  if (worst === 'medium') return 'Something about this message does not add up. Check who sent it before you act on it.';
  return 'Postroom noticed something unusual about this message.';
}

export const PHISH_TONE_OF: Record<PhishWarning['severity'], 'danger' | 'warning' | 'info'> = { high: 'danger', medium: 'warning', low: 'info' };
