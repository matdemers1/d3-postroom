// PST-T-17.17 (PST-REQ-005, PST-REQ-194): the entry shell — Sign in, Setup, re-enrolment and the
// Gate's own states in one split layout after Bindery's front door. Rendered to static markup, so the
// structure is asserted without a DOM; the CSS is read as text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLabel } from '../../src/entry/build';
import { ENTRY_CLAIMS, ENTRY_HEADLINE, ENTRY_HEADLINE_ACCENT, ENTRY_PROMISE, EntryHeading, EntryNotes, EntryShell } from '../../src/entry/EntryShell';
import { D3AUTH_DOWN, D3AUTH_LABEL, D3AUTH_START, SignInWithD3Auth } from '../../src/entry/SignInWithD3Auth';

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');
const count = (html: string, re: RegExp): number => html.match(re)?.length ?? 0;

const shell = (wide = false): string =>
  renderToStaticMarkup(
    createElement(EntryShell, {
      wide,
      children: [
        createElement(EntryHeading, { key: 'h', title: 'Sign in', children: 'Welcome back to your mail.' }),
        createElement('form', { key: 'f', 'aria-label': 'The form' }),
      ],
    }),
  );

describe('EntryShell', () => {
  const html = shell();

  it('is a story aside and a main, side by side', () => {
    expect(html).toMatch(/^<div class="pr-entry"><aside aria-label="About Postroom" class="pr-entry__story">/);
    expect(count(html, /<aside /g)).toBe(1);
    expect(count(html, /<main /g)).toBe(1);
    // The form is in <main>, after the aside.
    const main = html.slice(html.indexOf('<main '));
    expect(main).toContain('aria-label="The form"');
    expect(main).toContain('<h1 tabindex="-1" class="pr-entry__title">Sign in</h1>');
    expect(html.slice(0, html.indexOf('<main '))).not.toContain('The form');
  });

  it('keeps exactly one h1 — the form’s — and gives the story an h2 headline with its accent half', () => {
    expect(count(html, /<h1[ >]/g)).toBe(1);
    expect(count(html, /<h2[ >]/g)).toBe(1);
    expect(html).toContain(`<h2 class="pr-entry__headline">${ENTRY_HEADLINE} <span class="pr-entry__headline-accent">${ENTRY_HEADLINE_ACCENT}</span></h2>`);
    expect(ENTRY_HEADLINE).toBe('Your mail, sorted —');
    expect(ENTRY_HEADLINE_ACCENT).toBe('and it says why.');
  });

  it('makes the promise and the three checkable claims, each with a check glyph', () => {
    expect(html).toContain(`<p class="pr-entry__promise">${ENTRY_PROMISE}</p>`);
    expect(ENTRY_PROMISE).toContain('Mail for d3cloud.io on a server you own.');
    expect(ENTRY_CLAIMS.map((c) => c.title)).toEqual(['Every sort shows its reason.', 'No AI reads your mail.', 'Nothing phones home.']);
    expect(count(html, /<li class="pr-entry__claim">/g)).toBe(3);
    expect(count(html, /class="pr-entry__tick"/g)).toBe(3);
    for (const c of ENTRY_CLAIMS) expect(html).toContain(`<span class="pr-entry__claim-title">${c.title}</span> ${c.detail}`);
  });

  it('carries the Postroom mark and name twice: in the story, and above the form for narrow screens', () => {
    expect(count(html, /class="pr-entry__brand"/g)).toBe(1);
    expect(count(html, /class="pr-entry__brand pr-entry__brand--compact"/g)).toBe(1);
    // Decorative beside the word, so a screen reader hears "Postroom" once per brand.
    expect(count(html, /<svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true">/g)).toBe(2);
  });

  it('draws a decorative, tokens-only illustration', () => {
    const art = /<svg viewBox="0 0 300 256"[^>]*>[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
    expect(art).toContain('aria-hidden="true"');
    expect(art).toContain('class="pr-entry__art"');
    expect(count(art, /pr-entry-art__fan/g)).toBe(3);
    expect(art).toContain('pr-entry-art__drop');
    expect(art).toContain('pr-entry-art__tag');
    expect(art).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('ends the story with a footer that says self-hosted (the build joins it once /health answers)', () => {
    expect(html).toContain('<footer class="pr-entry__foot"><span>self-hosted</span></footer>');
  });

  it('has a wider column for Setup and re-enrolment', () => {
    expect(html).toContain('class="pr-entry__column"');
    expect(shell(true)).toContain('class="pr-entry__column pr-entry__column--wide"');
  });

  it('EntryHeading leaves out the lede when there is none; EntryNotes has a row form', () => {
    expect(renderToStaticMarkup(createElement(EntryHeading, { title: 'Postroom' }))).toBe('<header class="pr-entry__heading"><h1 tabindex="-1" class="pr-entry__title">Postroom</h1></header>');
    expect(renderToStaticMarkup(createElement(EntryNotes, { row: true, children: 'x' }))).toBe('<div class="pr-entry__notes pr-entry__notes--row">x</div>');
  });
});

describe('the build label', () => {
  it('shows the first seven characters of a real revision', () => {
    expect(buildLabel('c65ecf7a1b2c3d4e5f')).toBe('c65ecf7');
    expect(buildLabel('abc')).toBe('abc');
  });

  it('hides dev, empty and missing values', () => {
    for (const value of ['dev', '', '  ', undefined, null, 42, {}]) expect(buildLabel(value)).toBeNull();
  });

  describe('from GET /health', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetModules();
    });

    it('asks once per page load and reads revision', async () => {
      const fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ status: 'ok', revision: '0123456789abcdef', schemaRevision: '7' }) });
      vi.stubGlobal('fetch', fetch);
      vi.resetModules();
      const { fetchBuildLabel } = await import('../../src/entry/build');
      expect(await fetchBuildLabel()).toBe('0123456');
      expect(await fetchBuildLabel()).toBe('0123456');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[0]).toBe('/health');
    });

    it('is null when the answer is not JSON, or there is no answer', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.reject(new SyntaxError('not json')) }));
      vi.resetModules();
      expect(await (await import('../../src/entry/build')).fetchBuildLabel()).toBeNull();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
      vi.resetModules();
      expect(await (await import('../../src/entry/build')).fetchBuildLabel()).toBeNull();
    });
  });
});

describe('Sign in with D3 Auth', () => {
  const render = (configured: boolean, available: boolean): string => renderToStaticMarkup(createElement(SignInWithD3Auth, { configured, available }));

  it('is a real navigation link, bordered and full width, under an "or" divider', () => {
    const html = render(true, true);
    expect(html).toContain('<div class="pr-entry-or" aria-hidden="true"><span></span>or<span></span></div>');
    expect(html).toMatch(new RegExp(`<a class="pr-entry-sso" href="${D3AUTH_START}"><svg [^>]*aria-hidden="true"[^>]*>.*</svg>${D3AUTH_LABEL}</a>`));
    expect(D3AUTH_START).toBe('/api/auth/oidc/start');
    expect(D3AUTH_LABEL).toBe('Sign in with D3 Auth');
  });

  it('is a dashed box with the reason, and nothing to press, while D3 Auth is unreachable', () => {
    const html = render(true, false);
    expect(html).toContain('<p class="pr-entry-sso pr-entry-sso--down" role="status">');
    expect(html).toContain(`<span class="pr-entry-sso__why">${D3AUTH_DOWN}</span>`);
    expect(D3AUTH_DOWN).toBe('D3 Auth is unreachable right now. Your password still works.');
    expect(html).not.toMatch(/<a |<button/);
  });

  it('is nothing at all when D3 Auth is not configured', () => {
    expect(render(false, false)).toBe('');
    expect(render(false, true)).toBe('');
  });
});

describe('entry.css', () => {
  const css = read('entry/entry.css');

  it('splits from lg (1024px) up, with the story on the sunken ground behind a hairline', () => {
    const lg = css.slice(css.indexOf('@media (min-width: 64rem)'));
    expect(lg).toMatch(/\.pr-entry \{\s*grid-template-columns: minmax\(0, 1\.05fr\) minmax\(0, 1fr\);/);
    expect(lg).toMatch(/\.pr-entry__story \{[^}]*display: flex;[^}]*border-right: var\(--border-width\) solid var\(--color-border\);[^}]*background: var\(--color-bg-sunken\);/);
    expect(lg).toMatch(/\.pr-entry__brand--compact \{\s*display: none;/);
    // Below it the story is dropped.
    expect(css).toMatch(/^\.pr-entry__story \{\s*display: none;\s*\}/m);
  });

  it('centres the form column vertically and sizes it like Bindery’s', () => {
    expect(css).toMatch(/\.pr-entry__column \{[^}]*max-width: 384px;/);
    expect(css).toMatch(/\.pr-entry__column--wide \{\s*max-width: 448px;/);
    expect(css).toMatch(/@media \(min-width: 64rem\)[\s\S]*\.pr-entry__main \{\s*align-items: center;/);
  });

  it('plays the arrival once, and not at all under prefers-reduced-motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const cls of ['fan', 'trail', 'drop', 'tag']) expect(reduced).toContain(`.pr-entry-art__${cls}`);
    expect(reduced).toMatch(/\{\s*animation: none;\s*\}/);
    expect(css).toContain('.pr-entry__story[data-settled] .pr-entry-art__fan');
    // Backwards fill only: nothing keeps a transform once it has arrived.
    expect(css).not.toMatch(/animation:[^;]*\b(forwards|both)\b/);
  });

  it('uses tokens only: no raw colour, no shadow, and the display size says why', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/box-shadow|drop-shadow/);
    expect(css).toMatch(/d3-allow: [^\n]*display headline[\s\S]{0,400}font-size: 40px;/);
  });
});

describe('the screens use the shell, and AuthLayout is gone from them', () => {
  it('Sign in, Setup, re-enrolment and the Gate', () => {
    for (const file of ['screens/SignIn.tsx', 'screens/Setup.tsx', 'screens/reenrol/ReEnrol.tsx', 'App.tsx']) {
      const src = read(file);
      expect(src, file).not.toContain('AuthLayout');
      expect(src, file).toMatch(/<EntryShell( wide)?>/);
    }
    expect(read('screens/Setup.tsx')).toContain('<EntryShell wide>');
    expect(read('screens/reenrol/ReEnrol.tsx')).toContain('<EntryShell wide>');
  });

  it('Sign in: the heading, the D3 Auth states from the auth state, and the footer line', () => {
    const src = read('screens/SignIn.tsx');
    expect(src).toContain('<EntryHeading title="Sign in">');
    expect(src).toContain("'Welcome back to your mail.'");
    expect(src).toContain("'One more step: one of your recovery codes.'");
    expect(src).toContain("'One more step: the code from your authenticator.'");
    expect(src).toContain('<SignInWithD3Auth configured={state.oidcConfigured} available={state.oidcAvailable} />');
    expect(src).toContain('<p>New here? Accounts are made by whoever runs this server.</p>');
    // One toggle, not two: the recovery switch appears once.
    expect(src.match(/USE_RECOVERY_LABEL/g)).toHaveLength(2); // the import and the one use
  });

  it('the Gate: its two states keep their h1s, and the not-answering one still takes focus', () => {
    const app = read('App.tsx');
    expect(app).toContain('<EntryHeading title="Postroom is not answering" focusOnMount />');
    expect(app).toContain('<EntryHeading title="Postroom" />');
  });
});
