// PST-T-8.3 — RFC 6764 discovery: the records a domain publishes and the well-known redirect.
import { describe, expect, it } from 'vitest';
import { discoveryRecords, wellKnownLocation, wellKnownService } from '../../src/well-known.js';

describe('wellKnownService', () => {
  it('names only the two exact paths', () => {
    expect(wellKnownService('/.well-known/caldav')).toBe('caldav');
    expect(wellKnownService('/.well-known/carddav')).toBe('carddav');
    expect(wellKnownService('/.well-known/caldav/')).toBeNull();
    expect(wellKnownService('/.well-known/autoconfig')).toBeNull();
  });
});

describe('wellKnownLocation', () => {
  it('is the context path on the DAV host, absolute from elsewhere, and never plain http', () => {
    expect(wellKnownLocation()).toBe('/dav/');
    expect(wellKnownLocation('https://dav.d3cloud.io')).toBe('https://dav.d3cloud.io/dav/');
    expect(() => wellKnownLocation('http://dav.d3cloud.io')).toThrow(/https/);
  });
});

describe('discoveryRecords', () => {
  const records = discoveryRecords('d3cloud.io', 'dav.d3cloud.io');

  it('publishes TLS SRV and a path TXT for both services', () => {
    for (const svc of ['caldav', 'carddav']) {
      expect(records).toContainEqual(expect.objectContaining({ type: 'SRV', name: `_${svc}s._tcp.d3cloud.io`, value: '0 1 443 dav.d3cloud.io.' }));
      expect(records).toContainEqual(expect.objectContaining({ type: 'TXT', name: `_${svc}s._tcp.d3cloud.io`, value: '"path=/dav/"' }));
    }
  });

  it('marks plaintext DAV as not offered, so no client sends an app password in the clear', () => {
    const plain = records.filter((r) => r.name.startsWith('_caldav._tcp') || r.name.startsWith('_carddav._tcp'));
    expect(plain).toHaveLength(2);
    for (const r of plain) expect(r.value).toBe('0 0 0 .');
  });

  it('refuses names that are not plain DNS names', () => {
    expect(() => discoveryRecords('d3cloud.io', 'dav d3cloud.io')).toThrow();
  });
});
