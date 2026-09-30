// PST-T-15.8 (PST-REQ-194): the phone drawn to the redesign canvas's PhoneInbox, PhoneThread and
// PhoneCompose artboards. The thread's bottom bar is rendered to a string with plain stand-ins for
// @d3cloud/ui's ActionBar and ActionBarItem that print the props it hands them; the list's bars, the composer's sheet and the phone-only CSS are held by a source scan,
// so an edit that undoes one fails here before a screenshot would show it. The browser half — 44 px
// targets by hit-test, no sideways scroll, axe in both themes — is e2e/tests/mobile.spec.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Mailbox, MessageDetail, SpecialUse } from '../../src/api';

vi.mock('@d3cloud/ui', () => {
  type P = { children?: ReactNode; label?: string; className?: string; tone?: string; disabled?: boolean; forceVisible?: boolean; 'aria-label'?: string; 'data-testid'?: string };
  const box = (tag: string) => (p: P) => createElement(tag, { className: p.className }, p.children);
  return {
    ActionBar: (p: P) => createElement('div', { role: 'group', 'aria-label': p['aria-label'], 'data-force': p.forceVisible, 'data-testid': p['data-testid'], className: p.className }, p.children),
    ActionBarItem: (p: P) => createElement('button', { type: 'button', 'aria-label': p['aria-label'], 'data-tone': p.tone ?? 'default', disabled: p.disabled }, p.label),
    Menu: box('div'),
    MenuTrigger: box('span'),
    MenuContent: box('div'),
    MenuItem: (p: P) => createElement('div', { role: 'menuitem' }, p.children),
    MenuSeparator: () => null,
    Tooltip: (p: P) => p.children,
  };
});

const MAILBOXES: Mailbox[] = (['inbox', 'sent', 'drafts', 'junk', 'archive', 'trash'] as SpecialUse[]).map((use) => ({
  id: `mb-${use}`,
  name: use === 'inbox' ? 'INBOX' : use,
  specialUse: use,
  total: 0,
  unseen: 0,
})) as unknown as Mailbox[];

vi.mock('../../src/mail/MailContext', () => ({
  useMail: () => ({ mailboxes: MAILBOXES, me: 'operator@d3cloud.io', refreshMailboxes: () => Promise.resolve(), subscribe: () => () => undefined, live: true, mailboxesFailed: false }),
}));

const { MobileActionBar } = await import('../../src/mail/thread/MobileActionBar');
const { ContextBar } = await import('../../src/mobile/ContextBar');

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

function detail(use: SpecialUse): MessageDetail {
  return {
    id: 'm-1',
    mailboxId: `mb-${use}`,
    uid: 1,
    modseq: '1',
    threadId: null,
    subject: 'Acadia over Columbus Day weekend?',
    from: 'priya.shah@gmail.com',
    date: '2026-09-26T12:30:00Z',
    internalDate: '2026-09-26T12:30:00Z',
    size: 10,
    flags: [],
    bucket: null,
    messageIdHeader: null,
    inReplyTo: null,
    references: [],
    verdict: null,
    phish: null,
  };
}

const bar = (use: SpecialUse, can = { archive: true, trash: true }) =>
  renderToStaticMarkup(createElement(MobileActionBar, { detail: detail(use), canArchive: can.archive, canTrash: can.trash, onAction: () => undefined, onMoveTo: () => undefined }));

/** Each item's visible word, in order, with its accessible name when that differs. */
function items(html: string): string[] {
  const out: string[] = [];
  const re = /<button([^>]*)>([^<]*)<\/button>/g;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const name = /aria-label="([^"]*)"/.exec(m[1] ?? '')?.[1];
    out.push(name === undefined ? (m[2] ?? '') : `${m[2] ?? ''} (${name})`);
  }
  return out;
}

describe('the thread’s bottom bar is the library ActionBar (PhoneThread)', () => {
  it('is a labelled, forced-visible group of Archive, Delete, Move, Reply and More', () => {
    const html = bar('inbox');
    expect(html).toMatch(/^<div role="group" aria-label="Message actions" data-force="true" data-testid="action-bar" class="pr-abar">/);
    expect(items(html)).toEqual(['Archive', 'Delete', 'Move', 'Reply', 'More (More actions)']);
  });

  it('marks Reply as the one accent, and every item is a plain button', () => {
    const html = bar('inbox');
    expect(html.match(/data-tone="accent"/g)).toHaveLength(1);
    expect(html).toContain('<button type="button" data-tone="accent">Reply</button>');
  });

  it('keeps each mailbox’s buttons: Not junk (the accent) in place of Reply in Junk, no Reply in Drafts', () => {
    const junk = bar('junk');
    expect(items(junk)).toEqual(['Delete', 'Move', 'Not junk', 'More (More actions)']);
    expect(junk).toContain('<button type="button" data-tone="accent">Not junk</button>');
    expect(items(bar('drafts'))).toEqual(['Delete', 'Move', 'More (More actions)']);
  });

  it('disables Archive and Delete where the mailbox cannot', () => {
    const html = bar('inbox', { archive: false, trash: false });
    expect(html.match(/<button type="button" data-tone="default" disabled="">/g)).toHaveLength(2);
  });
});

describe('the list’s bars (PhoneInbox)', () => {
  it('the top bar holds only Back, with no hairline and no title of its own', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ContextBar, { back: { to: '/mail', label: 'Mailboxes' }, flush: true })));
    expect(html).toContain('class="pr-cbar pr-cbar--flush"');
    expect(html).toContain('href="/mail"');
    expect(html).toContain('<p class="pr-cbar__title" aria-hidden="true"></p><div class="pr-cbar__actions"></div>');
    const plain = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ContextBar, { title: 'Mailboxes' })));
    expect(plain).toContain('class="pr-cbar"');
  });

  it('MailView: the list’s bar is Back alone, and the bottom bar says the list is current and offers New message', () => {
    const view = read('mail/MailView.tsx');
    expect(view).toContain("{!split ? <ContextBar back={{ to: '/mail', label: 'Mailboxes' }} flush /> : null}");
    expect(view).toContain('<div className="pr-lbar" data-testid="list-bar">');
    expect(view).toContain("{live && searchQuery === null ? 'Updated just now' : null}");
    // Every phone compose control is called New message (the canvas's words); none is "Compose".
    expect(view).not.toMatch(/label="Compose"/);
    expect(view.match(/label="New message"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(view).not.toContain('label="Search"');
  });

  it('draws the large title, edge-to-edge rows and the bottom bar', () => {
    const mobile = read('mobile/mobile.css');
    expect(mobile).toMatch(/\.pr-mail\[data-layout='push'\] \.pr-listhead__title \{\s*flex-direction: column;[^}]*font-size: var\(--text-24\);/);
    expect(mobile).toMatch(/\.pr-mail\[data-layout='push'\] \.pr-listhead__compose \{\s*display: none;/);
    expect(mobile).not.toMatch(/\.pr-listhead__row \{\s*position: absolute;/);
    expect(mobile).toMatch(/\.pr-lbar \{[^}]*grid-template-columns: 44px minmax\(0, 1fr\) 44px;/);
    expect(mobile).toMatch(/:root:has\(\.pr-lbar\) \.d3-toast-region \{\s*bottom: calc\(var\(--pr-lbar-height\) \+ var\(--space-8\)\);/);
    const list = read('mail/list/list.css');
    expect(list).toMatch(/\.pr-mail\[data-layout='push'\] \.pr-tlist__box \{\s*padding-inline: 0;/);
    expect(list).toMatch(/\.pr-mail\[data-layout='push'\] \.pr-mrow::after \{[^}]*left: calc\(var\(--space-16\) \+ var\(--space-40\) \+ var\(--space-12\)\);/);
  });
});

describe('the composer’s sheet (PhoneCompose)', () => {
  const composer = read('mail/Composer.tsx');

  it('has Cancel, the title and a round Send that submits the same form as the split button', () => {
    expect(composer).toMatch(/<div className="pr-compose__sheetbar">\s*<Button type="button" variant="ghost" className="pr-compose__cancel" onClick=\{onDiscard\}>\s*Cancel\s*<\/Button>\s*<HeadingTag id=\{titleId\}/);
    expect(composer).toContain('<IconButton type="submit" label={sendWord} icon={<SendArrow />} loading={sending} disabled={loadingDraft || busyUploading} className="pr-compose__sheetsend" />');
    expect(read('mail/MailView.tsx')).toContain('sheet={!split && composesInPane(route.compose)}');
  });

  it('keeps Send later, the reminder and the undo window in ⋯ More when the split button is not drawn', () => {
    expect(composer).toContain('{sheet ? null : (');
    expect(composer.match(/\{sendMenuItems\}/g)).toHaveLength(2);
    expect(composer).toMatch(/\{sheet \? \(\s*<>\s*\{sendMenuItems\}\s*<MenuSeparator \/>/);
    for (const item of ['Send later…', 'Remind me if no reply…', 'Undo send window…']) expect(composer).toContain(`>${item}</MenuItem>`);
  });

  it('draws the sheet bar and the 32 px accent disc in a 44 px target, on a phone only', () => {
    const css = read('mail/compose/composer.css');
    expect(css).toMatch(/\.pr-mail\[data-layout='push'\] \.pr-compose__sheetbar \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, auto\) minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.pr-mail\[data-layout='push'\] \.pr-compose__sheetsend \{[^}]*width: 44px;\s*height: 44px;/);
    expect(css).toMatch(/\.pr-mail\[data-layout='push'\] \.pr-compose__sheetsend > span \{[^}]*width: 32px;[^}]*background: var\(--color-accent\);/);
    expect(css).not.toMatch(/(^|\n)\.pr-compose__sheet(bar|send)/);
  });
});

describe('the thread’s subject on a phone', () => {
  it('is a 20 px title', () => {
    expect(read('mail/thread/thread.css')).toMatch(/\.pr-mail\[data-layout='push'\] \.pr-reader__subject \{\s*font-size: var\(--text-20\);/);
  });
});
