// PST-T-16.17 (closes PST-DA-029 remainder): one verb for ending a browser session ("Sign out",
// never "Revoke"), one name for the session you are using ("This browser"), and the evidence behind
// the friendly "Chrome on macOS" — the full user agent and the IP — in a disclosure.
// Rendered to a string with react-dom/server, like delivery-rows.test.ts.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@d3cloud/ui', () => {
  const box = (tag: string) => (props: { children?: ReactNode }) => createElement(tag, null, props.children);
  const item = (props: { term: ReactNode; children?: ReactNode }) =>
    createElement('div', null, createElement('dt', null, props.term), createElement('dd', null, props.children));
  return { DescriptionList: box('dl'), DescriptionItem: item };
});
vi.mock('../../src/api', () => ({ ApiError: class extends Error {}, api: {}, describeError: String }));

import { CURRENT_SESSION_LABEL, END_SESSION_LABEL, SessionDetails } from '../../src/screens/Sessions';
import { readFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

describe('session labels', () => {
  it('uses one verb for ending a session and one name for the current one', () => {
    expect(END_SESSION_LABEL).toBe('Sign out');
    expect(CURRENT_SESSION_LABEL).toBe('This browser');
  });

  it.each(['Sessions.tsx', 'AdminSessions.tsx'])('%s renders neither "Revoke" nor "This session"', (file) => {
    const source = readFileSync(new URL(`../../src/screens/${file}`, import.meta.url), 'utf8');
    expect(source).not.toMatch(/Revoke/);
    expect(source).not.toMatch(/This session/);
    expect(source).toContain('END_SESSION_LABEL');
    expect(source).toContain('CURRENT_SESSION_LABEL');
  });
});

describe('SessionDetails', () => {
  it('discloses the full user agent and the IP, in mono', () => {
    const html = renderToStaticMarkup(createElement(SessionDetails, { userAgent: UA, ip: '203.0.113.7' }));
    expect(html).toContain('<summary>Details</summary>');
    expect(html).toContain(UA);
    expect(html).toContain('203.0.113.7');
    expect(html).toContain('pr-mono');
  });

  it('says Unknown when the agent or the address was not recorded', () => {
    const html = renderToStaticMarkup(createElement(SessionDetails, { userAgent: null, ip: null }));
    expect(html.match(/Unknown/g)).toHaveLength(2);
  });
});
