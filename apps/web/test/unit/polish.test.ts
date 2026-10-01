// PST-T-14.11 (PST-REQ-155, PST-ADR-011): polish from the after-captures. The status mapping is
// pure; the layout fixes are CSS, held here by a source scan so a later edit that undoes one fails
// before a screenshot would show it. The screenshots themselves are the design audit's recapture.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATUS_TONE, toneKind, verdictKind } from '../../src/status/status';
import { showsKeyHints } from '../../src/mail/useMedia';

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

describe('one status mapping for Health and Inspect (D-016 tones)', () => {
  it('has no green: good and unknown are neutral, warning takes the D3 UI 1.5 warning tone (D-086, never the link violet), bad is danger', () => {
    expect(STATUS_TONE).toEqual({ good: 'neutral', unknown: 'neutral', warning: 'warning', bad: 'danger' });
  });

  it('reads verdicts the same way everywhere: pass and "not listed" are good results', () => {
    expect(verdictKind('pass')).toBe('good');
    expect(verdictKind('not listed')).toBe('good');
    expect(verdictKind('none')).toBe('unknown');
    expect(verdictKind('softfail')).toBe('warning');
    expect(verdictKind('temperror')).toBe('warning');
    expect(verdictKind('fail')).toBe('bad');
    expect(verdictKind('permerror')).toBe('bad');
    expect(verdictKind('listed')).toBe('bad');
  });

  it('keeps a crypto tone and tells a pass from no verdict', () => {
    expect(toneKind('neutral', true)).toBe('good');
    expect(toneKind('neutral', false)).toBe('unknown');
    expect(toneKind('attention', false)).toBe('warning');
    expect(toneKind('warning', false)).toBe('warning');
    expect(toneKind('danger', true)).toBe('bad');
  });

  // Health's tones moved to StatusDot in PST-T-15.7 (D-016/D-080) and are pinned in admin-health.test.ts.
  it('Inspect badges go through StatusBadge, and Unknown is not attention', () => {
    const inspect = read('mail/InspectDrawer.tsx');
    expect(inspect).toContain('<StatusBadge kind={verdictKind(result)}>');
    expect(inspect).not.toMatch(/<Badge tone=\{(resultTone|part\.tone)/);
    // Each outcome has its own glyph, so tone is never the only signal.
    const css = read('status/status.css');
    for (const kind of ['good', 'unknown', 'warning', 'bad']) expect(css).toContain(`.pr-status[data-status='${kind}']::before`);
  });
});

describe('the Undo toast on a phone', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws the z keycap only when the primary pointer is fine', () => {
    vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: q !== '(pointer: fine)' }) });
    expect(showsKeyHints()).toBe(false);
    vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: q === '(pointer: fine)' }) });
    expect(showsKeyHints()).toBe(true);
    expect(read('mail/MailView.tsx')).toContain("...(showsKeyHints() ? { shortcut: 'z' } : {})");
  });

  it('rises above the bottom action bar while the bar is on screen', () => {
    const css = read('mobile/mobile.css');
    expect(css).toMatch(/:root:has\(\.pr-abar\) \.d3-toast-region \{\s*bottom: calc\(var\(--pr-abar-height\) \+ var\(--space-8\)\);/);
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.d3-toast__kbd \{\s*display: none;/);
  });
});

describe('layout fixes', () => {
  it('the composer body spans its rows, is padded, and has no resize grip', () => {
    const css = read('mail/compose/composer.css');
    const body = /\.pr-compose__body \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(body).toContain('width: 100%;');
    expect(body).toContain('padding: var(--space-8) var(--space-12);');
    expect(body).not.toContain('max-width');
    expect(css).toMatch(/\.pr-compose__body\.d3-inp--area \.d3-inp__control \{\s*resize: none;/);
  });

  it('every phone context bar sticks flush at the top of a padded scroller', () => {
    const css = read('mobile/mobile.css');
    expect(css).toMatch(/\.pr-reader:not\(\.pr-reader--open\) > \.pr-cbar \{\s*top: calc\(var\(--space-16\) \* -1\);/);
    expect(css).toMatch(/\.pr-mail__feed > \.pr-cbar \{\s*top: calc\(var\(--space-16\) \* -1\);/);
    expect(css).toMatch(/\.pr-mail__feed > \.pr-listhead__title \{\s*position: absolute;/);
  });

  it('the row action cluster sits in reserved space and a first-time sender keeps their name', () => {
    const css = read('mail/list/list.css');
    expect(css).toMatch(/\.pr-mrow--acting \.pr-mrow__line,\s*\.pr-mrow--acting \.pr-mrow__subject \{\s*padding-right:/);
    expect(css).toMatch(/\.pr-mrow__name \{\s*flex: 0 0 auto;/);
    expect(read('mail/list/TriageList.tsx')).toContain('acting={m.id === actingId}');
  });

  it('the Person card routes with the design-system Select, and Account is titled Account', () => {
    const card = read('mail/sorting/PersonCard.tsx');
    expect(card).not.toMatch(/<select\b/);
    expect(card).toMatch(/<Select\s+appearance="filled"/);
    expect(read('screens/ChangePassword.tsx')).toContain('<PageHeader title="Account"');
  });

  it('the Security & devices links sit under each page title, not above it', () => {
    expect(read('screens/Shell.tsx')).not.toContain('<SubNav');
    for (const page of ['screens/Sessions.tsx', 'screens/AppPasswords.tsx', 'screens/DeviceSetup.tsx']) {
      const text = read(page);
      expect(text.indexOf('<SubNav />'), page).toBeGreaterThan(text.indexOf('<PageHeader'));
    }
  });
});
