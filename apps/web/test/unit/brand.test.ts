// PST-T-16.10 (PST-DA-055): a Postroom-specific mark in the shell brand, on the sign-in card and
// as the favicon, and one positioning line under the sign-in heading.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostroomMark } from '../../src/brand/PostroomMark';

const WEB = join(__dirname, '../..');
const read = (path: string) => readFileSync(join(WEB, path), 'utf8');

describe('PostroomMark', () => {
  it('stands alone as an image named Postroom', () => {
    const html = renderToStaticMarkup(createElement(PostroomMark));
    expect(html).toMatch(/^<svg /);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Postroom"');
  });

  it('is hidden from assistive tech where the word Postroom is beside it', () => {
    const html = renderToStaticMarkup(createElement(PostroomMark, { decorative: true }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain('aria-label');
  });

  it('is drawn on D3 tokens, with no raw colour', () => {
    const html = renderToStaticMarkup(createElement(PostroomMark));
    expect(html).toContain('var(--color-accent)');
    expect(html).toContain('var(--color-fg)');
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe('where the mark is used', () => {
  it('AppShellBrand takes the Postroom mark, not MailIcon', () => {
    const shell = read('src/screens/Shell.tsx');
    const brand = /<AppShellBrand[^>]*>/.exec(shell)?.[0] ?? '';
    expect(brand).toContain('PostroomMark');
    expect(brand).not.toContain('MailIcon');
  });

  it('the sign-in card carries the mark and one positioning line', () => {
    const signIn = read('src/screens/SignIn.tsx');
    expect(signIn).toMatch(/brand=\{<PostroomMark /);
    expect(signIn).toContain('Your own mail server for d3cloud.io');
  });
});

describe('favicon', () => {
  it('index.html links the svg', () => {
    expect(read('index.html')).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/);
  });

  it('is the same mark with light and dark colours chosen by prefers-color-scheme', () => {
    const svg = read('public/favicon.svg');
    expect(svg).toContain('prefers-color-scheme: dark');
    expect(svg).toContain('#5432be'); // --color-accent, light
    expect(svg).toContain('#978cff'); // --color-accent, dark
  });
});
