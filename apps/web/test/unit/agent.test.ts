import { describe, expect, it } from 'vitest';
import { describeAgent } from '../../src/screens/agent';

describe('describeAgent', () => {
  it('names the browser and the system, not the raw string', () => {
    expect(describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')).toBe('Chrome on macOS');
    expect(describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
    expect(describeAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0')).toBe('Edge on Windows');
    expect(describeAgent('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')).toBe('Firefox on Linux');
    expect(describeAgent('Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36')).toBe('Chrome on Android');
  });

  it('falls back to words, never to the raw string', () => {
    expect(describeAgent(null)).toBe('Unknown device');
    expect(describeAgent('  ')).toBe('Unknown device');
    expect(describeAgent('curl/8.7.1')).toBe('Unknown browser');
    expect(describeAgent('SomeBot (Linux)')).toBe('A browser on Linux');
  });
});
