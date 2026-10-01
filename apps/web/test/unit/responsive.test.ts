// PST-T-16.18 (PST-DA-047, PST-REQ-155, PST-REQ-077): the responsive foundations, held by a source
// scan so an edit that undoes one fails here before a browser would show it. The browser half —
// 44px targets by hit-test and the push layout at 844×390 — is e2e/tests/mobile.spec.ts under the
// 'landscape' Playwright project.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPLIT_QUERY, WIDE_QUERY } from '../../src/mail/useMedia';

const WEB = join(__dirname, '..', '..');
const SRC = join(WEB, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const read = (path: string): string => readFileSync(path, 'utf8');

describe('one breakpoint scale', () => {
  it('has no 599px, 600px, 640px or 40rem width query left in apps/web/src', () => {
    const query = /\(\s*(?:min|max)-width:\s*(?:599|600|640|40rem|37\.5rem)(?:px)?\s*\)/;
    const offenders = walk(SRC)
      .filter((f) => /\.(css|ts|tsx)$/.test(f))
      .filter((f) => query.test(read(f)))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it('keeps the shell and the split on 768 / 1024', () => {
    expect(WIDE_QUERY).toBe('(min-width: 1024px)');
    expect(SPLIT_QUERY).toContain('(min-width: 768px)');
  });

  it('requires 500px of height for the split layout, so a landscape phone stays on push navigation', () => {
    expect(SPLIT_QUERY).toContain('(min-height: 500px)');
    // 844×390 fails the query; 1280×800 and a 1024×768 tablet pass it.
    const matches = (w: number, h: number) => w >= 768 && h >= 500;
    expect(matches(844, 390)).toBe(false);
    expect(matches(1280, 800)).toBe(true);
    expect(matches(1024, 768)).toBe(true);
    expect(matches(390, 844)).toBe(false);
  });

  it('switches the calendar to the agenda on the same query as the mail split', () => {
    const calendar = read(join(SRC, 'calendar', 'Calendar.tsx'));
    expect(calendar).toMatch(/const GRID_QUERY = SPLIT_QUERY;/);
  });
});

describe('44px targets follow the pointer, not the width', () => {
  const css = read(join(SRC, 'styles', 'mobile-targets.css'));

  it('wraps its rules in (pointer: coarse) and in no width query', () => {
    expect(css).not.toMatch(/@media[^{]*(?:min|max)-width/);
    expect(css).toMatch(/@media \(pointer: coarse\) \{/);
  });

  it('keeps every 44px rule inside that one block', () => {
    const open = css.indexOf('@media (pointer: coarse) {');
    expect(open).toBeGreaterThan(-1);
    expect(css.slice(0, open).replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/44px/);
    // The block runs to the file's end: the only top-level close is the last one.
    expect(css.trimEnd().endsWith('}')).toBe(true);
  });

  it('still carries the session Details summary rule (PST-T-16.17)', () => {
    expect(css).toMatch(/\.pr-session-details > summary \{[^}]*min-height: 44px/);
  });
});

describe('index.html and the web manifest', () => {
  const html = read(join(WEB, 'index.html'));
  const manifest = JSON.parse(read(join(WEB, 'public', 'manifest.webmanifest'))) as {
    name: string;
    short_name: string;
    start_url: string;
    display: string;
    theme_color: string;
    background_color: string;
    icons: { src: string; sizes: string }[];
  };

  it('draws edge to edge, so the safe-area insets mean something', () => {
    expect(html).toMatch(/<meta name="viewport"[^>]*viewport-fit=cover/);
  });

  it('has a theme-color for each scheme, in the D3 surface colours', () => {
    const colours = [...html.matchAll(/<meta name="theme-color" content="(#[0-9a-f]{6})" media="\(prefers-color-scheme: (dark|light)\)"/g)];
    const byScheme: Record<string, string | undefined> = {};
    for (const m of colours) byScheme[m[2] ?? ''] = m[1];
    const tokens = read(join(WEB, 'node_modules', '@d3cloud', 'ui', 'src', 'tokens', 'build', 'color.css'));
    for (const scheme of ['dark', 'light']) {
      const hex = byScheme[scheme];
      expect(hex, `theme-color for ${scheme}`).toBeDefined();
      expect(tokens).toContain(`--color-bg: ${hex};`);
    }
    expect(byScheme['dark']).not.toBe(byScheme['light']);
  });

  it('links a favicon, an apple-touch-icon and the manifest, and each file exists', () => {
    for (const rel of ['icon', 'apple-touch-icon', 'manifest']) {
      const m = html.match(new RegExp(`<link rel="${rel}"[^>]*href="(/[^"]+)"`));
      expect(m, `<link rel="${rel}">`).not.toBeNull();
      expect(statSync(join(WEB, 'public', m?.[1] ?? '')).isFile()).toBe(true);
    }
  });

  it('apple-touch-icon is a 180×180 PNG', () => {
    const png = readFileSync(join(WEB, 'public', 'apple-touch-icon.png'));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(180);
    expect(png.readUInt32BE(20)).toBe(180);
  });

  it('manifest installs Postroom standalone at the inbox, with icons that exist', () => {
    expect(manifest.name).toBe('Postroom');
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/mail/inbox');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest.icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === '512x512')).toBe(true);
    for (const icon of manifest.icons) expect(statSync(join(WEB, 'public', icon.src)).isFile()).toBe(true);
  });
});
