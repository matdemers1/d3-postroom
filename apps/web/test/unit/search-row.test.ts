// PST-T-17.5 (PST-DA-082): "Clear search" stays inside the list column. jsdom does no layout, so
// this pins the CSS rule that guarantees it: the field may shrink, the button may not.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/mail/mail.css', import.meta.url), 'utf8');
const rule = (selector: string): string => {
  const m = new RegExp(`${selector.replace(/[.>*]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
  return m?.[1] ?? '';
};

describe('the list header search row', () => {
  it('lets the field shrink and keeps the button whole', () => {
    expect(rule('.pr-search > :first-child')).toMatch(/min-width:\s*0/);
    expect(rule('.pr-search__clear')).toMatch(/flex:\s*none/);
  });

  it('the Clear search button carries that class', () => {
    const tsx = readFileSync(new URL('../../src/mail/MailView.tsx', import.meta.url), 'utf8');
    expect(tsx).toMatch(/className="pr-search__clear"[^>]*onClick=\{clearSearch\}/);
  });
});
