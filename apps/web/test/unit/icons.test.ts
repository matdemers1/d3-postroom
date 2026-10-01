// PST-T-16.3 (PST-DA-018): Junk, Rejects and each sorted bucket have an icon of their own.
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { FolderIcon, mailboxIcon } from '../../src/mail/icons';

const kind = (use: Parameters<typeof mailboxIcon>[0], name: string): unknown => (mailboxIcon(use, name) as ReactElement).type;

describe('mailboxIcon', () => {
  it('gives Junk, Rejects, Updates, Receipts, Notifications and Newsletters six distinct icons', () => {
    const icons = [kind('junk', 'Junk'), kind('rejects', 'Rejects'), kind(null, 'Updates'), kind(null, 'Receipts'), kind(null, 'Notifications'), kind(null, 'Newsletters')];
    expect(new Set(icons).size).toBe(6);
    for (const icon of icons) expect(icon).not.toBe(FolderIcon);
  });

  it('leaves your own folders on the plain folder icon', () => {
    expect(kind(null, 'Projects')).toBe(FolderIcon);
  });
});
