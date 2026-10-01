// PST-T-16.6 — first run: the TOTP key as a QR drawn in the browser and in four-character groups
// (PST-REQ-196, PST-DA-037), an expired enrolment that recovers in place (PST-DA-038), and the
// operator landing on the setup wizard rather than the empty Inbox (PST-DA-036).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../src/api';
import {
  AFTER_SETUP,
  afterCompleteFailure,
  EMPTY_SETUP_FORM,
  EXPIRED_MESSAGE,
  isEnrolTokenError,
  keyGroups,
  type SetupForm,
  startOver,
} from '../../src/screens/setup/enrolment';
import { QUIET_ZONE, qrShape } from '../../src/screens/setup/qr';
import { TotpQr } from '../../src/screens/setup/TotpQr';

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/Postroom:operator?secret=${SECRET}&issuer=Postroom&algorithm=SHA1&digits=6&period=30`;

/** The form as it stands on the enrolment step, everything typed. */
const enrolling: SetupForm = {
  ...EMPTY_SETUP_FORM,
  setupToken: 'the-setup-token',
  displayName: 'Matthew',
  login: 'operator',
  password: 'correct horse battery staple',
  confirm: 'correct horse battery staple',
  enrol: { enrolToken: 'enrol-token', secret: SECRET, otpauthUri: URI },
  code: '123456',
};

/** setup/complete answered with `body` at `status`, through the real API client. */
async function refusal(status: number, body: unknown): Promise<unknown> {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))));
  return api.setupComplete({ setupToken: 'the-setup-token', enrolToken: 'enrol-token', code: '123456' }).then(
    () => {
      throw new Error('expected a refusal');
    },
    (caught: unknown) => caught,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('an expired enrolment recovers in place (PST-DA-038)', () => {
  it('setup_expired returns to the first step, keeping token, name and login, clearing only the passwords', async () => {
    const caught = await refusal(400, { error: 'setup_expired' });
    expect(caught).toBeInstanceOf(ApiError);
    const after = afterCompleteFailure(enrolling, caught);
    expect(after.enrol).toBeNull(); // the first step
    expect(after.setupToken).toBe('the-setup-token');
    expect(after.displayName).toBe('Matthew');
    expect(after.login).toBe('operator');
    expect(after.password).toBe('');
    expect(after.confirm).toBe('');
    expect(after.code).toBe('');
    expect(after.error).toBe(EXPIRED_MESSAGE);
    expect(after.error).toContain('That took too long — press Continue to get a new key');
  });

  it('any enrol-token error restarts the same way: a 400 naming the enrolToken field', async () => {
    const caught = await refusal(400, { error: 'invalid_request', fields: [{ path: 'enrolToken', message: 'Required' }] });
    expect(isEnrolTokenError(caught)).toBe(true);
    const after = afterCompleteFailure(enrolling, caught);
    expect(after.enrol).toBeNull();
    expect(after.error).toBe(EXPIRED_MESSAGE);
  });

  it('a wrong code stays on the enrolment step, clearing only the code', async () => {
    const caught = await refusal(400, { error: 'invalid_code' });
    expect(isEnrolTokenError(caught)).toBe(false);
    const after = afterCompleteFailure(enrolling, caught);
    expect(after.enrol).toEqual(enrolling.enrol);
    expect(after.password).toBe(enrolling.password);
    expect(after.code).toBe('');
    expect(after.error).toBe('That code didn’t match. Try the current one.');
  });

  it('an unreachable server is not an expired enrolment', () => {
    const after = afterCompleteFailure(enrolling, new TypeError('Failed to fetch'));
    expect(after.enrol).not.toBeNull();
    expect(after.error).toMatch(/^Postroom didn’t answer\./);
  });

  it("'Start over' returns to the first step the same way, with no banner", () => {
    const after = startOver({ ...enrolling, error: 'That code didn’t match. Try the current one.' });
    expect(after).toEqual({ ...enrolling, password: '', confirm: '', enrol: null, code: '', error: null });
  });

  it('the enrolment step has a Start over button wired to startOver', () => {
    const src = read('screens/Setup.tsx');
    expect(src).toMatch(/onClick=\{\(\) => \{\s*setForm\(startOver\);\s*\}\}\s*>\s*Start over\s*</);
    expect(src).toContain('setForm((f) => afterCompleteFailure(f, caught))');
  });
});

describe('the key in four-character groups with a Copy control (PST-REQ-196)', () => {
  it('splits a 32-character key into eight groups that join back to the secret', () => {
    const groups = keyGroups(SECRET);
    expect(groups).toHaveLength(8);
    expect(groups.every((g) => g.length === 4)).toBe(true);
    expect(groups.join('')).toBe(SECRET);
    expect(keyGroups('ABCDEF')).toEqual(['ABCD', 'EF']);
  });

  it('renders the groups as elements, not spaces, and copies the ungrouped secret', () => {
    const src = read('screens/Setup.tsx');
    expect(src).toMatch(/keyGroups\(enrol\.secret\)\.map\(\(group, i\) => \(\s*<span key=\{String\(i\)\}>\{group\}<\/span>/);
    expect(src).toContain('<CopyButton value={enrol.secret} label="setup key" />');
  });
});

describe('the QR is drawn in the browser, with no request (PST-REQ-196, PST-DA-037)', () => {
  it('has a four-module quiet zone on every side', () => {
    const { size, path } = qrShape(URI);
    const coords = [...path.matchAll(/M(\d+) (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    expect(coords.length).toBeGreaterThan(100);
    const xs = coords.map(([x]) => x);
    const ys = coords.map(([, y]) => y);
    expect(Math.min(...xs)).toBe(QUIET_ZONE);
    expect(Math.min(...ys)).toBe(QUIET_ZONE);
    expect(Math.max(...xs)).toBe(size - QUIET_ZONE - 1);
    expect(Math.max(...ys)).toBe(size - QUIET_ZONE - 1);
    // A version's module count is 17 + 4v; the quiet zone adds eight.
    expect((size - 2 * QUIET_ZONE - 17) % 4).toBe(0);
  });

  it('is the same picture for the same URI, and a different one for another', () => {
    expect(qrShape(URI)).toEqual(qrShape(URI));
    expect(qrShape(URI).path).not.toBe(qrShape(URI.replace(SECRET, 'A'.repeat(32))).path);
  });

  it('renders inline SVG with an accessible name, on a light island in either theme', () => {
    const html = renderToStaticMarkup(createElement(TotpQr, { uri: URI }));
    expect(html).toMatch(/^<div class="pr-totp-qr" data-theme="light"><svg role="img" aria-label="QR code for your authenticator app"/);
    expect(html).toContain('class="pr-totp-qr__light"');
    expect(html).toContain('class="pr-totp-qr__dark"');
    // Nothing to fetch: no <img>, no URL of any kind, no data: URL — the CSP is untouched.
    expect(html).not.toMatch(/<img|href=|src=|data:|https?:|url\(/);
    expect(html).not.toContain(SECRET); // the secret is in the pixels, not the markup
  });

  it('never asks the library for an image tag or a data URL', () => {
    const dir = join(SRC, 'screens/setup');
    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/createImgTag|createDataURL|createSvgTag|createTableTag/);
    }
  });

  it('dark modules on a light surface, from existing tokens', () => {
    const css = read('screens/setup/totp.css');
    expect(css).toMatch(/\.pr-totp-qr__light \{\s*fill: var\(--color-surface-raised\);/);
    expect(css).toMatch(/\.pr-totp-qr__dark \{\s*fill: var\(--color-fg\);/);
  });
});

describe('after Finish setup the operator lands on the setup wizard (PST-DA-036)', () => {
  it('goes to /admin/setup, not the Inbox', () => {
    expect(AFTER_SETUP).toBe('/admin/setup');
    const src = read('screens/Setup.tsx');
    expect(src).toContain('window.location.replace(AFTER_SETUP)');
    expect(src).not.toMatch(/navigate\('\/'/);
  });
});
