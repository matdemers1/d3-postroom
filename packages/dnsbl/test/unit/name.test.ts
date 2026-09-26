import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dnsblQueryName, reversedAddressLabels } from '../../src/name.js';

describe('reversedAddressLabels / dnsblQueryName', () => {
  it('reverses IPv4 octets and appends the zone', () => {
    expect(dnsblQueryName('127.0.0.2', 'zen.spamhaus.org')).toBe('2.0.0.127.zen.spamhaus.org.');
  });

  it('strips a trailing dot from the zone before appending', () => {
    expect(dnsblQueryName('127.0.0.2', 'zen.spamhaus.org.')).toBe('2.0.0.127.zen.spamhaus.org.');
  });

  it('nibble-reverses IPv6 addresses', () => {
    // ::1 expands to 0000:...:0001, so the reversed nibbles are 31 zeros then a 1, then ip6.arpa.
    const name = dnsblQueryName('::1', 'zen.spamhaus.org');
    expect(name.endsWith('.zen.spamhaus.org.')).toBe(true);
    expect(name.startsWith('1.0.0.0.')).toBe(true);
    expect(name.split('.').length).toBe(32 + 3 + 1); // 32 nibbles + "zen" "spamhaus" "org" + trailing empty
  });

  it('round trip: reversing the reversed labels back recovers the original IPv4 octets', () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })),
        ([a, b, c, d]) => {
          const ip = `${String(a)}.${String(b)}.${String(c)}.${String(d)}`;
          const labels = reversedAddressLabels(ip);
          const recovered = labels.split('.').reverse().join('.');
          expect(recovered).toBe(ip);
        },
      ),
    );
  });

  it('query name for IPv4 is always <reversed>.<zone>.', () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })),
        ([a, b, c, d]) => {
          const ip = `${String(a)}.${String(b)}.${String(c)}.${String(d)}`;
          const name = dnsblQueryName(ip, 'zen.spamhaus.org');
          expect(name).toBe(`${d}.${c}.${b}.${a}.zen.spamhaus.org.`);
        },
      ),
    );
  });
});
