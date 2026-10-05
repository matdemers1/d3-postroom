// PST-T-20.1: "Open in D3 Constellation" — a d3constellation://<host>/postroom/message/<id> link,
// offered only on Apple devices (iPadOS Safari says Macintosh), as a secondary small button.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// @d3cloud/ui's dist imports its own CSS, which Node cannot load: Button is a stub that shows the
// props this screen promises (variant, size, an icon).
vi.mock('@d3cloud/ui', async () => {
  const { createElement: h } = await import('react');
  return {
    Button: (props: { variant?: string; size?: string; type?: string; icon?: unknown; children?: unknown }) =>
      h('button', { type: props.type, 'data-variant': props.variant, 'data-size': props.size }, props.icon as never, props.children as never),
  };
});

import { constellationLink, messageLink, onApple, OpenInConstellation } from '../../src/components/OpenInConstellation';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

describe('Open in D3 Constellation (PST-T-20.1)', () => {
  it('links the message on this host, the path the app routes', () => {
    expect(messageLink('6f1c2a3b-0000-4000-8000-000000000001', 'mail.d3cloud.io')).toBe('d3constellation://mail.d3cloud.io/postroom/message/6f1c2a3b-0000-4000-8000-000000000001');
    expect(constellationLink('priority', 'mail.d3cloud.io')).toBe('d3constellation://mail.d3cloud.io/postroom/priority');
    expect(constellationLink('message/a b', 'mail.d3cloud.io:8443')).toBe('d3constellation://mail.d3cloud.io:8443/postroom/message/a%20b');
  });

  it('is offered on iPhone, iPad and Mac only', () => {
    expect(onApple(IPHONE)).toBe(true);
    expect(onApple(IPAD)).toBe(true);
    expect(onApple(ANDROID)).toBe(false);
    expect(onApple(WINDOWS)).toBe(false);
  });

  it('draws a secondary small button with its label on Apple, and nothing elsewhere', () => {
    const apple = renderToStaticMarkup(createElement(OpenInConstellation, { messageId: 'm1', userAgent: IPHONE }));
    expect(apple).toContain('Open in D3 Constellation');
    expect(apple).toContain('<button type="button" data-variant="secondary" data-size="sm">');
    expect(apple).toContain('<svg');
    expect(renderToStaticMarkup(createElement(OpenInConstellation, { messageId: 'm1', userAgent: WINDOWS }))).toBe('');
  });
});
