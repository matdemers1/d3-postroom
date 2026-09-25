import { describe, expect, it } from 'vitest';
import { describeDaemon } from '../../src/daemon.js';

describe('smtp-in', () => {
  it('names itself', () => {
    expect(describeDaemon()).toBe('postroom smtp-in');
  });
});
