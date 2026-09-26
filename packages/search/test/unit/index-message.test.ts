import { describe, expect, it } from 'vitest';
import { htmlToText, truncateUtf8 } from '../../src/index-message.js';

describe('htmlToText', () => {
  it('strips tags and decodes entities', () => {
    expect(htmlToText('<p>Hello &amp; <b>world</b></p>')).toBe('Hello & world');
  });

  it('drops script and style contents entirely', () => {
    expect(htmlToText('<style>.a{color:red}</style><p>Body</p><script>evil()</script>')).toBe('Body');
  });

  it('turns block breaks into newlines', () => {
    expect(htmlToText('<div>line one</div><div>line two</div>')).toBe('line one\nline two');
  });

  it('decodes numeric character references', () => {
    expect(htmlToText('caf&#233; &#x2019;s')).toBe("café ’s");
  });
});

describe('truncateUtf8', () => {
  it('leaves short text untouched', () => {
    expect(truncateUtf8('hello', 256)).toBe('hello');
  });

  it('truncates to at most maxBytes without splitting a multi-byte character', () => {
    const text = '€'.repeat(10); // each € is 3 bytes in UTF-8
    const truncated = truncateUtf8(text, 10);
    const bytes = new TextEncoder().encode(truncated);
    expect(bytes.length).toBeLessThanOrEqual(10);
    // Decoding never produced a replacement character from a split boundary.
    expect(truncated).not.toContain('�');
  });
});
