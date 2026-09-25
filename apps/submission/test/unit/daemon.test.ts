import { describe, expect, it } from 'vitest';
import { describeDaemon } from '../../src/daemon.js';

describe('submission', () => {
  it('names itself', () => {
    expect(describeDaemon()).toBe('postroom submission');
  });
});
