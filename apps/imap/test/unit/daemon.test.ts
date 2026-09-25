import { describe, expect, it } from 'vitest';
import { describeDaemon } from '../../src/daemon.js';

describe('imap', () => {
  it('names itself', () => {
    expect(describeDaemon()).toBe('postroom imap');
  });
});
