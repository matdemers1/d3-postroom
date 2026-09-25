import { describe, expect, it } from 'vitest';
import { describeDaemon } from '../../src/daemon.js';

describe('dav', () => {
  it('names itself', () => {
    expect(describeDaemon()).toBe('postroom dav');
  });
});
