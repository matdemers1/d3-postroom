import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { sha256Hex, timingSafeEqualStr } from '../../src/index.js';

describe('sha256Hex', () => {
  it('agrees for a buffer and a stream of the same bytes', async () => {
    const data = Buffer.from('From: a@d3cloud.io\r\n\r\nbody\r\n');
    const expected = createHash('sha256').update(data).digest('hex');
    expect(sha256Hex(data)).toBe(expected);
    expect(await sha256Hex(Readable.from([data.subarray(0, 5), data.subarray(5)]))).toBe(expected);
  });
});

describe('timingSafeEqualStr', () => {
  it('compares strings of any length', () => {
    expect(timingSafeEqualStr('secret', 'secret')).toBe(true);
    expect(timingSafeEqualStr('secret', 'secreT')).toBe(false);
    expect(timingSafeEqualStr('secret', 'secret-longer')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });
});
