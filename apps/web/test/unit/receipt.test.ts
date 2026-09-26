import { describe, expect, it } from 'vitest';
import { wantsReceipt } from '../../src/mail/receipt';

const asked = { headers: [{ name: 'Disposition-Notification-To', value: 'a@example.org' }] };

describe('wantsReceipt', () => {
  it('offers a receipt for a message that asked and has none yet', () => {
    expect(wantsReceipt({ flags: [] }, asked, false)).toBe(true);
  });

  it('never offers twice, for our own copies, or when nobody asked', () => {
    expect(wantsReceipt({ flags: ['$MDNSent'] }, asked, false)).toBe(false);
    expect(wantsReceipt({ flags: [] }, asked, true)).toBe(false);
    expect(wantsReceipt({ flags: [] }, { headers: [] }, false)).toBe(false);
    expect(wantsReceipt({ flags: [] }, null, false)).toBe(false);
  });
});
