// PST-T-16.19 (closes PST-DA-026 and PST-DA-056; PST-REQ-084): the ? overlay has a Close button, its
// keycaps do not wrap, its copy and column header read as the review asked, and it lists the go-to
// chords. The unit environment is Node with no DOM, so the Modal is a stand-in that keeps what the
// overlay relies on: the title, description and footer, and a ModalClose that calls onOpenChange(false)
// the way the library's Dialog.Close does. The live "press Close, the dialog goes" is e2e.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloneElement, createContext, createElement, useContext, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const closers: (() => void)[] = [];

vi.mock('@d3cloud/ui', () => {
  const Ctx = createContext<(open: boolean) => void>(() => undefined);
  return {
    Button: ({ children, ...rest }: { children?: ReactNode }) => createElement('button', { type: 'button', ...rest }, children),
    Modal: ({ open, onOpenChange, title, description, footer, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; footer?: ReactNode; children?: ReactNode }) =>
      open
        ? createElement(Ctx.Provider, { value: onOpenChange }, createElement('div', { role: 'dialog' }, createElement('h2', null, title), createElement('p', null, description), children, createElement('footer', null, footer)))
        : null,
    ModalClose: ({ children }: { children: ReactElement }) => {
      const onOpenChange = useContext(Ctx);
      closers.push(() => {
        onOpenChange(false);
      });
      return cloneElement(children, { 'data-close': 'true' } as never);
    },
  };
});

const { ShortcutsOverlay } = await import('../../src/mail/ShortcutsOverlay');
const { overlayShortcuts, SHORTCUTS } = await import('../../src/mail/keys');

const markup = (open = true): string => renderToStaticMarkup(createElement(ShortcutsOverlay, { open, onOpenChange: () => undefined }));

describe('the shortcuts overlay', () => {
  it('has a Close button, and pressing it closes the overlay', () => {
    closers.length = 0;
    const onOpenChange = vi.fn();
    const html = renderToStaticMarkup(createElement(ShortcutsOverlay, { open: true, onOpenChange }));
    expect(html).toMatch(/<button[^>]*data-close="true"[^>]*>Close<\/button>/);
    expect(closers).toHaveLength(1);
    closers[0]?.();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing while closed', () => {
    expect(markup(false)).toBe('');
  });

  it('reads “Work in any mailbox, except while you’re typing in a field.” and heads the column Action', () => {
    const html = markup();
    expect(html).toContain('Work in any mailbox, except while you’re typing in a field.');
    expect(html).not.toContain('They work anywhere');
    expect(html).toContain('<th scope="col">Action</th>');
    expect(html).not.toContain('>Does<');
  });

  it('lists g then i, s, d, c and p, each once', () => {
    const html = markup();
    for (const [keys, label] of [
      ['g then i', 'Go to Inbox'],
      ['g then s', 'Go to Sent'],
      ['g then d', 'Go to Drafts'],
      ['g then c', 'Go to Calendar'],
      ['g then p', 'Go to Contacts'],
    ] as const) {
      expect(html.split(`<kbd>${keys}</kbd>`)).toHaveLength(2);
      expect(html).toContain(`<td>${label}</td>`);
    }
  });

  it('lists every SHORTCUTS row, in order, with the extra chords after g then i', () => {
    const rows = overlayShortcuts();
    expect(rows.filter((r) => SHORTCUTS.some((s) => s.action === r.id)).map((r) => r.id)).toEqual(SHORTCUTS.map((s) => s.action));
    const at = rows.findIndex((r) => r.id === 'goInbox');
    expect(rows.slice(at + 1, at + 5).map((r) => r.keys)).toEqual(['g then s', 'g then d', 'g then c', 'g then p']);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('keeps a keycap on one line', () => {
    const css = readFileSync(join(import.meta.dirname, '../../src/mail/mail.css'), 'utf8');
    const rule = /\.pr-shortcuts kbd \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('white-space: nowrap');
  });
});
