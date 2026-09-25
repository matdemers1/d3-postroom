import { describe, expect, it } from 'vitest';
import { describeDaemon } from '../../src/daemon.js';

describe('delivery', () => {
  it('names itself', () => {
    expect(describeDaemon()).toBe('postroom delivery');
  });
});
