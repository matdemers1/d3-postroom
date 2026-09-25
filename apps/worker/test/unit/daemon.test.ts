import { describe, expect, it } from 'vitest';
import { describeDaemon } from '../../src/daemon.js';

describe('worker', () => {
  it('names itself', () => {
    expect(describeDaemon()).toBe('postroom worker');
  });
});
