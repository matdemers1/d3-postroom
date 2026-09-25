import { describe, expect, it } from 'vitest';
import { describeDaemon } from '../../src/daemon.js';

describe('api', () => {
  it('names itself', () => {
    expect(describeDaemon()).toBe('postroom api');
  });
});
