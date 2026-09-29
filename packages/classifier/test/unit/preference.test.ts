// PST-T-14.9: which key a sorting correction's sender preference is recorded on.
import { describe, expect, it } from 'vitest';
import { domainPreferenceKey, isDomainPreference, prefersDomain } from '../../src/preference.js';

describe('sender preferences (PST-T-14.9)', () => {
  it('keys a domain preference as @domain, normalized', () => {
    expect(domainPreferenceKey('Notifications+x@GitHub.com.')).toBe('@github.com');
    expect(domainPreferenceKey('no-at-sign')).toBeNull();
  });

  it('tells a domain key from an address', () => {
    expect(isDomainPreference('@github.com')).toBe(true);
    expect(isDomainPreference('jane@example.com')).toBe(false);
    expect(isDomainPreference('@')).toBe(false);
  });

  it('offers the domain only for automated buckets and never for a mailbox provider', () => {
    expect(prefersDomain('notifications@github.com', 'notifications')).toBe(true);
    expect(prefersDomain('notifications@github.com', 'priority')).toBe(false);
    expect(prefersDomain('jane@gmail.com', 'newsletters')).toBe(false);
    expect(prefersDomain('jane@Fastmail.com', 'updates')).toBe(false);
  });
});
