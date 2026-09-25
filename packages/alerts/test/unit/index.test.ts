import { describe, expect, it } from 'vitest';
import { PACKAGE } from '../../src/index.js';

describe('@postroom/alerts', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE).toBe('@postroom/alerts');
  });
});
