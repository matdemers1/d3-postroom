// PST-T-16.10 (PST-DA-055): a Postroom-specific mark in the shell brand, on the sign-in card and
// as the favicon, and one positioning line under the sign-in heading. PST-T-18.1 (DI-REQ-040): the
// mark is now the D3 Cloud family mark, concept Envelope, as d3cloud.io draws it.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POSTROOM_STAR, PostroomMark } from '../../src/brand/PostroomMark';

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

  // PST-T-18.1 (DI-REQ-040): the family mark — the planisphere's ring with the Envelope inside it,
  // as d3cloud.io draws it.
  it('is the family mark: the ring, the envelope, two joints and the lit star where the flap points', () => {
    const html = renderToStaticMarkup(createElement(PostroomMark));
    expect(html).toContain('viewBox="0 0 64 64"');
    expect(html).toMatch(/<circle cx="32" cy="32" r="26"/);
    expect(html).toContain('d="M17 22 H47 V44 H17 Z"');
    expect(html).toContain('d="M17 22 L32 34.5 L47 22"');
    expect(html).toMatch(/<circle cx="17" cy="22" r="3.4" fill="currentColor"/);
    expect(html).toMatch(/<circle cx="47" cy="22" r="3.4" fill="currentColor"/);
    expect(html).toMatch(/<circle cx="32" cy="34.5" r="5.5" style="fill:#E06AB8"/);
  });

  it('inks in the text colour, and its one colour is the lit star', () => {
    const html = renderToStaticMarkup(createElement(PostroomMark));
    expect(html).toContain('stroke="currentColor"');
    expect(html).not.toContain('var(--color-accent)');
    expect([...new Set(html.match(/#[0-9a-f]{3,8}\b/gi))]).toEqual([POSTROOM_STAR]);
    expect(POSTROOM_STAR).toBe('#E06AB8');
  });

  it('draws the site\'s icon weight below 72px and the finer display weight at 72px and up', () => {
    const icon = renderToStaticMarkup(createElement(PostroomMark, { size: 28 }));
    expect(icon).toContain('stroke-width="3.5"');
    expect(icon).toMatch(/r="3.4"/);
    expect(icon).toMatch(/r="5.5"/);
    const display = renderToStaticMarkup(createElement(PostroomMark, { size: 72 }));
    expect(display).toContain('stroke-width="2.2"');
    expect(display).toMatch(/r="2.6"/);
    expect(display).toMatch(/r="4.4"/);
    expect(display).not.toContain('stroke-width="3.5"');
  });

  it('defines the star colour once, with its reason', () => {
    const src = read('src/brand/PostroomMark.tsx');
    expect(src.match(/#E06AB8/g)).toHaveLength(1);
    expect(src).toMatch(/\/\/ d3-allow: .*DI-REQ-040.*\n.*#E06AB8/);
  });
});

describe('where the mark is used', () => {
  it('AppShellBrand takes the Postroom mark, not MailIcon', () => {
    const shell = read('src/screens/Shell.tsx');
    const brand = /<AppShellBrand[^>]*>/.exec(shell)?.[0] ?? '';
    expect(brand).toContain('PostroomMark');
    expect(brand).not.toContain('MailIcon');
  });

  // PST-T-18.1: AppShellBrand paints its mark slot with the accent; the family mark's ink is the
  // text colour, so the shell's mark carries a class that sets it back.
  it('the shell brand inks the mark in the text colour, not the accent', () => {
    const shell = read('src/screens/Shell.tsx');
    expect(shell).toContain('mark={<PostroomMark decorative className="pr-brand-mark" />}');
    expect(read('src/styles/places.css')).toMatch(/\.pr-brand-mark \{\s*color: var\(--color-fg\);\s*\}/);
    expect(shell).toContain("import '../styles/places.css';");
  });

  // PST-T-17.17: the sign-in card became the split entry shell; the mark sits beside the name in
  // the story panel and above the form on narrow screens, and the positioning line is the promise.
  it('the entry shell carries the mark beside the name, and one positioning line', () => {
    const shell = read('src/entry/EntryShell.tsx');
    expect(shell.match(/<PostroomMark size=\{28\} decorative \/> Postroom/g)).toHaveLength(2);
    expect(shell).toContain('Mail for d3cloud.io on a server you own.');
    expect(read('src/screens/SignIn.tsx')).toContain('<EntryShell>');
  });
});

describe('favicon', () => {
  it('index.html links the svg', () => {
    expect(read('index.html')).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/);
  });

  it('is the same drawing, at icon weight, with the ink chosen by prefers-color-scheme and the star fixed', () => {
    const svg = read('public/favicon.svg');
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).toContain('<circle cx="32" cy="32" r="26" />');
    expect(svg).toContain('d="M17 22 H47 V44 H17 Z"');
    expect(svg).toContain('d="M17 22 L32 34.5 L47 22"');
    expect(svg).toContain('stroke-width="3.5"');
    expect(svg).toMatch(/class="joint" cx="17" cy="22" r="3.4"/);
    expect(svg).toMatch(/class="joint" cx="47" cy="22" r="3.4"/);
    expect(svg).toMatch(/class="star" cx="32" cy="34.5" r="5.5"/);
    const [light, dark] = svg.split('prefers-color-scheme: dark');
    expect(light).toContain('.ink { stroke: #101117; }'); // --color-fg, light
    expect(dark).toContain('.ink { stroke: #f0f2f7; }'); // --color-fg, dark
    expect(light).toContain(`.star { fill: ${POSTROOM_STAR}; }`);
    expect(dark).not.toContain('.star');
  });
});
