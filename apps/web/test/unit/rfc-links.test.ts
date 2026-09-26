// PST-T-6.1, PST-REQ-115: learn mode's RFC registry. Every URL is an rfc-editor.org section anchor,
// and every anchor is the section that actually defines the thing (sources: the table in
// src/mail/rfc-links.ts, checked against each RFC's table of contents).
import { describe, expect, it } from 'vitest';
import {
  enhancedStatusRef,
  HEADER_REFS,
  headerRef,
  LEARN_MODE_KEY_PREFIX,
  MDN_REF,
  readLearnMode,
  replyCodeRef,
  rfcUrl,
  smtpReplyRefs,
  TLS_PROTOCOL_REF,
  verdictRef,
  writeLearnMode,
  type RfcRef,
  type VerdictKind,
} from '../../src/mail/rfc-links';

const URL_FORM = /^https:\/\/www\.rfc-editor\.org\/rfc\/rfc\d{3,5}#section-\d+(?:\.\d+)*$/;
const at = (ref: RfcRef | null): string | null => (ref === null ? null : `${String(ref.rfc)}§${ref.section}`);

/** The highest top-level section each cited RFC has — an anchor beyond it cannot resolve. */
const TOP_SECTIONS: Record<number, number> = { 2045: 10, 2183: 10, 2369: 5, 3463: 6, 3834: 9, 3848: 5, 5321: 7, 5322: 7, 5782: 7, 6376: 9, 7208: 12, 7489: 12, 8058: 6, 8098: 10, 8601: 7, 8617: 11 };

function allRefs(): RfcRef[] {
  const verdicts: [VerdictKind, string][] = [
    ['spf', 'pass'], ['spf', 'fail'], ['spf', 'softfail'], ['spf', 'neutral'], ['spf', 'none'], ['spf', 'temperror'], ['spf', 'permerror'], ['spf', 'odd'],
    ['dkim', 'pass'], ['dmarc', 'fail'], ['dmarc-policy', ''], ['alignment', ''], ['arc', 'pass'], ['dnsbl', 'listed'],
  ];
  return [
    ...Object.values(HEADER_REFS),
    ...verdicts.map(([k, r]) => verdictRef(k, r)).filter((x): x is RfcRef => x !== null),
    ...[250, 421, 550].map(replyCodeRef).filter((x): x is RfcRef => x !== null),
    ...['2.0.0', '4.1.1', '5.2.2', '4.3.0', '4.4.1', '5.5.1', '5.6.0', '5.7.1'].map(enhancedStatusRef).filter((x): x is RfcRef => x !== null),
    TLS_PROTOCOL_REF,
    MDN_REF,
  ];
}

describe('rfc-links registry (PST-REQ-115)', () => {
  it('every URL is an rfc-editor section anchor, inside an RFC that has that section', () => {
    for (const ref of allRefs()) {
      expect(rfcUrl(ref), ref.title).toMatch(URL_FORM);
      const top = Number(ref.section.split('.')[0]);
      const max = TOP_SECTIONS[ref.rfc];
      expect(max, `RFC ${String(ref.rfc)} is in the sources table`).toBeDefined();
      expect(top, `${String(ref.rfc)} §${ref.section}`).toBeGreaterThanOrEqual(1);
      expect(top).toBeLessThanOrEqual(max ?? 0);
      expect(ref.title.length).toBeGreaterThan(0);
    }
  });

  it('builds the URL rfc-editor.org uses', () => {
    expect(rfcUrl({ rfc: 5321, section: '4.4', title: 'x' })).toBe('https://www.rfc-editor.org/rfc/rfc5321#section-4.4');
  });

  it('maps the headers the brief names to their defining sections', () => {
    expect(at(headerRef('Received'))).toBe('5321§4.4');
    expect(at(headerRef('authentication-results'))).toBe('8601§2.2');
    expect(at(headerRef('DKIM-Signature'))).toBe('6376§3.5');
    expect(at(headerRef('ARC-Authentication-Results'))).toBe('8617§4.1.1');
    expect(at(headerRef('ARC-Message-Signature'))).toBe('8617§4.1.2');
    expect(at(headerRef('ARC-Seal'))).toBe('8617§4.1.3');
    expect(at(headerRef('Message-ID'))).toBe('5322§3.6.4');
    expect(at(headerRef('From'))).toBe('5322§3.6.2');
    expect(at(headerRef('Date'))).toBe('5322§3.6.1');
    expect(at(headerRef('Subject'))).toBe('5322§3.6.5');
    expect(at(headerRef('Return-Path'))).toBe('5322§3.6.7');
    expect(at(headerRef('List-Unsubscribe'))).toBe('2369§3.2');
    expect(at(headerRef('List-Unsubscribe-Post'))).toBe('8058§5');
    expect(at(headerRef('Disposition-Notification-To'))).toBe('8098§2.1');
    expect(at(headerRef('Content-Type'))).toBe('2045§5');
    expect(headerRef('X-Mailer')).toBeNull();
  });

  it('maps reply codes and enhanced status codes (RFC 5321 §4.2, RFC 3463 §3)', () => {
    expect(at(replyCodeRef(250))).toBe('5321§4.2.3');
    expect(replyCodeRef(199)).toBeNull();
    expect(replyCodeRef(600)).toBeNull();
    expect(at(enhancedStatusRef('2.0.0'))).toBe('3463§3.1');
    expect(at(enhancedStatusRef('5.1.1'))).toBe('3463§3.2');
    expect(at(enhancedStatusRef('4.2.2'))).toBe('3463§3.3');
    expect(at(enhancedStatusRef('5.7.1'))).toBe('3463§3.8');
    expect(enhancedStatusRef('5.8.1')).toBeNull();
    expect(enhancedStatusRef('3.0.0')).toBeNull();
    const refs = smtpReplyRefs('250 2.0.0 Queued as abc');
    expect([refs.codeText, refs.enhancedText, at(refs.code), at(refs.enhanced)]).toEqual(['250', '2.0.0', '5321§4.2.3', '3463§3.1']);
    expect(smtpReplyRefs('garbage').code).toBeNull();
  });

  it('maps verdict results (RFC 7208 §2.6, RFC 6376 §6, RFC 7489 §6.6, RFC 8617 §4.4)', () => {
    expect(at(verdictRef('spf', 'none'))).toBe('7208§2.6.1');
    expect(at(verdictRef('spf', 'Pass'))).toBe('7208§2.6.3');
    expect(at(verdictRef('spf', 'fail'))).toBe('7208§2.6.4');
    expect(at(verdictRef('spf', 'softfail'))).toBe('7208§2.6.5');
    expect(at(verdictRef('spf', 'permerror'))).toBe('7208§2.6.7');
    expect(at(verdictRef('spf', 'weird'))).toBe('7208§2.6');
    expect(at(verdictRef('dkim', 'pass'))).toBe('6376§6');
    expect(at(verdictRef('dmarc', 'fail'))).toBe('7489§6.6');
    expect(at(verdictRef('alignment'))).toBe('7489§3.1');
    expect(at(verdictRef('arc', 'pass'))).toBe('8617§4.4');
    expect(at(verdictRef('dnsbl'))).toBe('5782§2.1');
  });
});

describe('learn mode toggle', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  it('is remembered per account', () => {
    const s = memory();
    expect(readLearnMode('a', s)).toBe(false);
    writeLearnMode('a', true, s);
    expect(readLearnMode('a', s)).toBe(true);
    expect(readLearnMode('b', s)).toBe(false);
    expect(s.m.get(`${LEARN_MODE_KEY_PREFIX}a`)).toBe('1');
  });
  it('survives a storage that throws, or none at all', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readLearnMode('a', broken)).toBe(false);
    expect(() => { writeLearnMode('a', true, broken); }).not.toThrow();
    expect(readLearnMode('a', null)).toBe(false);
  });
});
