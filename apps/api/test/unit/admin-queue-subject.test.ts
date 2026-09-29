// PST-T-14.1 (design audit CPY-03): the admin queue's Subject column is decoded, never raw
// "=?UTF-8?Q?…?=" encoded-words. The route itself is covered in test/integration/admin-queue.test.ts.
import { describe, expect, it } from 'vitest';
import { queueSubject } from '../../src/admin-queue/index.js';

describe('queueSubject', () => {
  it('decodes Q and B encoded-words', () => {
    expect(queueSubject('=?UTF-8?Q?Your_old_tent_=E2=80=94_still_for_sale=3F?=')).toBe('Your old tent — still for sale?');
    expect(queueSubject('=?UTF-8?B?Q2Fmw6k=?= menu')).toBe('Café menu');
  });

  it('leaves a plain subject alone and keeps a missing one missing', () => {
    expect(queueSubject('Quarterly report')).toBe('Quarterly report');
    expect(queueSubject(null)).toBeNull();
  });

  it('never leaves an encoded-word marker in what it answers', () => {
    expect(queueSubject('=?utf-8?q?caf=C3=A9?= =?utf-8?q?_au_lait?=')).not.toMatch(/=\?/);
  });
});
