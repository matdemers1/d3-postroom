// PST-T-16.17 (closes PST-DA-029 remainder): one verb for ending a browser session ("Sign out",
// never "Revoke"), one name for the session you are using ("This browser"), and the evidence behind
// the friendly "Chrome on macOS" — the full user agent and the IP — in a disclosure (Admin › Sign-in
// sessions). PST-T-17.9: your own Browser sessions rows are one line, with no disclosure.
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

import { CURRENT_SESSION_LABEL, END_SESSION_LABEL, SessionDetails, sessionRowText } from '../../src/screens/Sessions';
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
    // Named for its session, the visible word leading (WCAG 2.5.3).
    expect(html).toContain('<summary aria-label="Details for Chrome on macOS">Details</summary>');
    expect(html).toContain(UA);
    expect(html).toContain('203.0.113.7');
    expect(html).toContain('pr-mono');
  });

  it('says Unknown when the agent or the address was not recorded', () => {
    const html = renderToStaticMarkup(createElement(SessionDetails, { userAgent: null, ip: null }));
    // The two recorded values (the summary's name may also say Unknown; that is not a value).
    expect(html.match(/>Unknown</g)).toHaveLength(2);
  });
});

describe('a Browser sessions row (PST-T-17.9, critique 2.3)', () => {
  const source = readFileSync(new URL('../../src/screens/Sessions.tsx', import.meta.url), 'utf8');
  const screen = source.slice(source.indexOf('export function Sessions('));

  it('names a known agent and marks the current one "This browser" once, on its right edge', () => {
    expect(sessionRowText({ userAgent: UA, ip: '203.0.113.7', current: true })).toEqual({ title: 'Chrome on macOS', lead: '203.0.113.7', marked: true });
    expect(sessionRowText({ userAgent: UA, ip: '203.0.113.7', current: false })).toEqual({ title: 'Chrome on macOS', lead: '203.0.113.7', marked: false });
  });

  it('calls the current session "This browser" when its agent cannot be named, with the family in the description', () => {
    expect(sessionRowText({ userAgent: 'curl/8.4.0', ip: '172.25.0.1', current: true })).toEqual({ title: CURRENT_SESSION_LABEL, lead: 'Unknown browser · 172.25.0.1', marked: false });
    expect(sessionRowText({ userAgent: null, ip: null, current: true })).toEqual({ title: CURRENT_SESSION_LABEL, lead: 'Unknown device · Unknown address', marked: false });
    expect(sessionRowText({ userAgent: 'curl/8.4.0', ip: null, current: false })).toEqual({ title: 'Unknown browser', lead: 'Unknown address', marked: false });
  });

  it('names a native app by the device it signed in from (PST-T-19.4)', () => {
    expect(sessionRowText({ userAgent: 'Constellation/1.0', ip: '10.0.0.4', current: false, deviceName: "Matt's iPhone", devicePlatform: 'ios' })).toEqual({
      title: "Matt's iPhone",
      lead: 'Constellation · 10.0.0.4',
      marked: false,
    });
    expect(sessionRowText({ userAgent: null, ip: null, current: false, deviceName: 'Studio', devicePlatform: 'macos' }).lead).toBe('Constellation on Mac · Unknown address');
  });

  it('draws no <details> disclosure, no badge in the meta column and no red row action', () => {
    expect(screen).not.toContain('<SessionDetails');
    expect(screen).not.toContain('<Badge');
    expect(screen).not.toContain('meta=');
    expect(screen).not.toContain('danger-ghost');
    expect(screen).toContain('<StatusDot size="sm" tone="neutral">');
    expect(screen).toContain('<RelativeTime iso={s.createdAt} />');
  });

  it('no longer holds the recovery codes (they belong to Account › Sign-in)', () => {
    expect(source).not.toContain('RecoveryCodesSection');
  });
});
