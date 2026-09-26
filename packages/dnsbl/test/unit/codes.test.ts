import { describe, expect, it } from 'vitest';
import { DNSBL_ERROR_CODES, isErrorCode, listForCode, shouldReject } from '../../src/codes.js';

describe('listForCode', () => {
  it.each([
    ['127.0.0.2', 'SBL'],
    ['127.0.0.3', 'SBL CSS'],
    ['127.0.0.4', 'XBL'],
    ['127.0.0.5', 'XBL'],
    ['127.0.0.6', 'XBL'],
    ['127.0.0.7', 'XBL'],
    ['127.0.0.9', 'DROP'],
    ['127.0.0.10', 'PBL'],
    ['127.0.0.11', 'PBL'],
  ] as const)('maps %s to %s', (code, list) => {
    expect(listForCode(code)).toBe(list);
  });

  it('returns undefined for an unmapped code', () => {
    expect(listForCode('127.0.0.99')).toBeUndefined();
    expect(listForCode('203.0.113.1')).toBeUndefined();
  });
});

describe('isErrorCode', () => {
  it('recognises the 127.255.255.x signalling range', () => {
    for (const code of Object.keys(DNSBL_ERROR_CODES)) {
      expect(isErrorCode(code)).toBe(true);
    }
  });

  it('does not treat an ordinary listing code as an error', () => {
    expect(isErrorCode('127.0.0.2')).toBe(false);
  });
});

describe('shouldReject', () => {
  it('rejects on SBL, SBL CSS, XBL or DROP', () => {
    expect(shouldReject(['SBL'])).toBe(true);
    expect(shouldReject(['SBL CSS'])).toBe(true);
    expect(shouldReject(['XBL'])).toBe(true);
    expect(shouldReject(['DROP'])).toBe(true);
  });

  it('does not reject on PBL alone', () => {
    expect(shouldReject(['PBL'])).toBe(false);
  });

  it('rejects when PBL is present alongside a reject-worthy list', () => {
    expect(shouldReject(['PBL', 'XBL'])).toBe(true);
  });

  it('does not reject with no lists', () => {
    expect(shouldReject([])).toBe(false);
  });
});
