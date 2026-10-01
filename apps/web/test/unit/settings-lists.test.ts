// PST-T-16.23 (PST-DA-054, PST-DA-057): App passwords, Addresses and Templates open on their list,
// with the create form absent from the DOM until the header "New …" button is pressed (that press is
// proved end to end in e2e/tests/account-security.spec.ts); a contact row shows the whole address.
// Rendered to a string with react-dom/server, like delivery-rows.test.ts.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { TemplatesScreen } from '../../src/compose/TemplatesScreen';
import { ContactSummaryLines } from '../../src/contacts/Contacts';
import { Aliases } from '../../src/screens/Aliases';
import { AppPasswords } from '../../src/screens/AppPasswords';

// The design system's stylesheet cannot load under Node, so every component is a plain box that
// renders what it is given: children, plus the slots (title, actions, empty) a screen fills.
vi.mock('@d3cloud/ui', () => {
  type Slots = { children?: ReactNode; title?: ReactNode; actions?: ReactNode; empty?: ReactNode; description?: ReactNode };
  const box = (props: Slots) => createElement('div', null, props.title, props.actions, props.description, props.children, props.empty);
  const button = (props: Slots) => createElement('button', null, props.children);
  const names = ['Alert', 'Badge', 'Checkbox', 'Cluster', 'DataList', 'DataListRow', 'EmptyState', 'FormActions', 'FormField', 'Input', 'Modal', 'ModalClose', 'Page', 'PageHeader', 'Section', 'Stack', 'Textarea', 'Link', 'Tabs', 'Tooltip', 'Skeleton', 'IconButton'];
  return { ...Object.fromEntries(names.map((n) => [n, box])), Button: button };
});

describe('settings lists first, forms on demand', () => {
  const cases: [string, () => string, string, string][] = [
    ['App passwords', () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AppPasswords))), 'New app password', 'Create password'],
    ['Addresses', () => renderToStaticMarkup(createElement(Aliases)), 'New alias', 'Create alias'],
    ['Templates', () => renderToStaticMarkup(createElement(TemplatesScreen)), 'New template', 'Create template'],
  ];
  for (const [screen, render, button, submit] of cases) {
    it(`${screen}: offers "${button}" in the header and renders no create form`, () => {
      const html = render();
      expect(html).toContain(button);
      expect(html).not.toContain('<form');
      expect(html).not.toContain(submit);
    });
  }
});

describe('a contact row', () => {
  const local = 'a-very-long-local-part-of-30-c'; // 30 characters
  const email = `${local}@long-domain-name.example.org`;
  const html = renderToStaticMarkup(
    createElement(ContactSummaryLines, {
      contact: { addressBookId: 'b', name: 'n', etag: 'e', uid: 'u', displayName: 'Ada', emails: [email], org: 'Analytical Engines', hasPhoto: false },
      book: 'Collected',
    }),
  );

  it('shows the full address, domain included, on its own line', () => {
    expect(local).toHaveLength(30);
    expect(html).toContain(`<br/>${email}`);
  });

  it('puts the address-book name in a Badge first, not joined into the description', () => {
    expect(html).toMatch(/^<[^>]*>Collected<\/[a-z]+>/);
    expect(html).not.toContain('·');
  });
});
