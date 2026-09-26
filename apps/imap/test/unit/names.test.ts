import { describe, expect, it } from 'vitest';
import { invalidNameReason } from '../../src/names.js';

describe('invalidNameReason', () => {
  it('refuses a level named . or .. (they would collide in exports and read as paths)', () => {
    for (const name of ['.', '..', 'a/..', './b', 'a/./b']) expect(invalidNameReason(name)).toMatch(/\. or \.\./);
  });

  it('still accepts names that merely contain dots', () => {
    for (const name of ['a.b', '...', 'Archive/2024.old', '.hidden']) expect(invalidNameReason(name)).toBeNull();
  });
});
