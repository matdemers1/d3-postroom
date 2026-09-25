import { describe, expect, it } from 'vitest';
import { describeDaemon } from '../../src/daemon.js';

describe('edge', () => {
  it('names itself', () => {
    expect(describeDaemon()).toBe('postroom edge');
  });
});
