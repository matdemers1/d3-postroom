// PST-T-17.12 (PST-REQ-194, PST-REQ-197): Recovery codes is a row of Settings › Account › Sign-in.
// The row sits in a <section> named by the row's own title, so the e2e contract holds: a region
// "Recovery codes" holding data-testid="recovery-status" and "Make new codes". Rendered to a string
// over a stand-in @d3cloud/ui (its real build imports CSS, which plain Node cannot load), like
// d3auth-console.test.ts; effects do not run on the server, so this is the first paint.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

type Props = Record<string, unknown> & { children?: ReactNode };

vi.mock('@d3cloud/ui', () => {
  const h = createElement;
  return {
    // The real SettingsRow gives its title the id `${id}-title` (and ids.labelledBy the same).
    SettingsRow: (p: Props) =>
      h(
        'div',
        { className: 'd3-setrow', id: p['id'] },
        h('div', { id: `${String(p['id'])}-title` }, p['title'] as ReactNode),
        h('div', { 'data-desc': '' }, p['description'] as ReactNode),
        h('div', { 'data-control': '' }, p['control'] as ReactNode),
      ),
    Button: (p: Props) => h('button', { 'data-variant': p['variant'] ?? 'secondary', 'data-size': p['size'], disabled: p['disabled'] === true }, p.children),
    StatusDot: (p: Props) => h('span', { 'data-tone': p['tone'] ?? 'neutral' }, p.children),
    Alert: (p: Props) => h('div', { 'data-alert': p['tone'] }, p.children),
    Modal: (p: Props) => (p['open'] === true ? h('div', { role: 'dialog' }, p['title'] as string, p.children, p['footer'] as ReactNode) : null),
    ModalClose: (p: Props) => p.children,
    FormField: (p: Props) => h('div', null, p.children),
    Input: () => h('input'),
    Checkbox: () => h('input', { type: 'checkbox' }),
    Cluster: (p: Props) => h('div', null, p.children),
    Stack: (p: Props) => h('div', null, p.children),
    FormActions: (p: Props) => h('div', null, p.children),
  };
});

import { RECOVERY_TITLE, RecoveryCodesSection } from '../../src/settings/RecoveryCodesSection';

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

describe('Recovery codes, a row of the Sign-in card', () => {
  const html = renderToStaticMarkup(createElement(RecoveryCodesSection));

  it('is a region named by the row’s title, exactly "Recovery codes"', () => {
    expect(RECOVERY_TITLE).toBe('Recovery codes');
    const labelledBy = /<section class="pr-recovery" aria-labelledby="([^"]+)">/.exec(html)?.[1];
    expect(labelledBy).toBeDefined();
    expect(html).toContain(`<div id="${String(labelledBy)}">Recovery codes</div>`);
  });

  it('holds the status line and "Make new codes" (secondary, small), not yet clickable while loading', () => {
    expect(html).toContain('<span data-testid="recovery-status">Loading…</span>');
    expect(html).toMatch(/<button data-variant="secondary" data-size="sm" disabled="">Make new codes<\/button>/);
    // No dialog until asked.
    expect(html).not.toContain('role="dialog"');
  });

  it('is one row of the card, not a Section card of its own', () => {
    const src = read('settings/RecoveryCodesSection.tsx');
    expect(src).not.toMatch(/<Section\b/);
    expect(src).toContain('<SettingsRow');
  });

  it('takes a row’s place in the card’s hairline sequence (account.css)', () => {
    const css = read('settings/account.css');
    expect(css).toMatch(/\.d3-setrow \+ \.pr-recovery,\s*\.pr-recovery \+ \.d3-setrow \{[^}]*border-top: var\(--border-width\) solid var\(--color-border\);/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
