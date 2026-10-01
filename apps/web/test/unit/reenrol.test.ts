// PST-T-16.26 (PST-REQ-200, PST-REQ-197): after a recovery-code sign-in the web app shows 'Set up a
// new authenticator' — the setup screen's QR and grouped key — then the new recovery codes behind
// "I have saved these", and only then carries on into the app. The component pulls in @d3cloud/ui's
// CSS, which Node cannot load, so its contract is read from the source; account-security.spec.ts
// drives it in a browser.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as apiModule from '../../src/api';
import { ApiError } from '../../src/api';
import { reenrolApi } from '../../src/screens/reenrol/api';
import {
  describeReenrolError,
  isReenrolDone,
  isReenrolKeyGone,
  needsReenrol,
  REENROL_CONTINUE_LABEL,
  REENROL_EXPIRED_MESSAGE,
  REENROL_SUBMIT_LABEL,
  REENROL_TITLE,
} from '../../src/screens/reenrol/reenrolment';

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('whether a sign-in has to re-enrol', () => {
  it('only when the server says so', () => {
    expect(needsReenrol({ next: 'done', reenrolRequired: true })).toBe(true);
    expect(needsReenrol({ next: 'done', reenrolRequired: false })).toBe(false);
    expect(needsReenrol({ next: 'done' })).toBe(false);
    expect(needsReenrol(null)).toBe(false);
    expect(needsReenrol('reenrolRequired')).toBe(false);
  });
});

describe('the calls', () => {
  it('begin and complete are POSTs under /api/auth/totp/reenrol; sign-in is the same second step', async () => {
    const call = vi.spyOn(apiModule, 'call').mockResolvedValue({});
    await reenrolApi.begin();
    await reenrolApi.complete('123456');
    await reenrolApi.signInTotp({ challenge: 'c', code: 'ABCDE-FGHJK' });
    expect(call).toHaveBeenNthCalledWith(1, 'POST', '/api/auth/totp/reenrol/begin');
    expect(call).toHaveBeenNthCalledWith(2, 'POST', '/api/auth/totp/reenrol/complete', { code: '123456' });
    expect(call).toHaveBeenNthCalledWith(3, 'POST', '/api/auth/signin/totp', { challenge: 'c', code: 'ABCDE-FGHJK' });
  });
});

describe('what a refusal says', () => {
  it('names a wrong code, an expired key, a finished re-enrolment and the step-up refusal in plain words', () => {
    expect(describeReenrolError(new ApiError(401, 'invalid_code', {}))).toBe('That code didn’t match. Enter the one your new authenticator shows now.');
    expect(describeReenrolError(new ApiError(400, 'reenrol_expired', {}))).toBe(REENROL_EXPIRED_MESSAGE);
    expect(describeReenrolError(new ApiError(409, 'reenrol_not_required', {}))).toMatch(/already has a working authenticator/);
    expect(describeReenrolError(new ApiError(403, 'totp_reenrol_required', {}))).toMatch(/Set up a new authenticator first/);
    expect(describeReenrolError(new ApiError(429, 'too_many_attempts', {}))).toMatch(/Too many attempts/);
    expect(describeReenrolError(new Error('offline'))).toMatch(/didn’t answer/);
  });

  it('tells an expired key and a finished re-enrolment apart from everything else', () => {
    expect(isReenrolKeyGone(new ApiError(400, 'reenrol_expired', {}))).toBe(true);
    expect(isReenrolKeyGone(new ApiError(401, 'invalid_code', {}))).toBe(false);
    expect(isReenrolDone(new ApiError(409, 'reenrol_not_required', {}))).toBe(true);
    expect(isReenrolDone(new Error('x'))).toBe(false);
  });

  it('uses typographic apostrophes in everything it shows', () => {
    const copy = [REENROL_EXPIRED_MESSAGE, describeReenrolError(new ApiError(401, 'invalid_code', {})), read('screens/reenrol/ReEnrol.tsx')];
    for (const text of copy) expect(text).not.toMatch(/[A-Za-z]'[a-z]/);
  });
});

describe('the screen', () => {
  const src = read('screens/reenrol/ReEnrol.tsx');

  it('is titled "Set up a new authenticator"', () => {
    expect(REENROL_TITLE).toBe('Set up a new authenticator');
    expect(src).toContain('title={REENROL_TITLE}');
  });

  it('reuses setup’s QR and grouped key, with copy and the otpauth link', () => {
    expect(src).toContain('<TotpQr uri={key.otpauthUri} />');
    expect(src).toContain('keyGroups(key.secret)');
    expect(src).toContain('data-testid="totp-secret"');
    expect(src).toContain('<CopyButton value={key.secret}');
    expect(src).toContain('href={key.otpauthUri}');
    expect(src).toContain('label="Authentication code"');
    expect(REENROL_SUBMIT_LABEL).toBe('Set up authenticator');
  });

  it('asks for a new key on arrival and when one expired', () => {
    expect(src).toContain('reenrolApi\n      .begin()');
    expect(src).toContain('newKey(REENROL_EXPIRED_MESSAGE)');
  });

  it('then shows the new recovery codes, and only their Continue carries on', () => {
    expect(src).toContain('<RecoveryCodes');
    expect(src).toContain('codes={recovery.codes}');
    expect(src).toContain('continueLabel={REENROL_CONTINUE_LABEL}');
    expect(REENROL_CONTINUE_LABEL).toBe('Continue to Postroom');
    expect(src).toMatch(/onContinue=\{\(\) => \{[\s\S]*onDone\(\)/);
  });
});

describe('sign-in hands a recovery-code session to the screen', () => {
  const src = read('screens/SignIn.tsx');

  it('reads reenrolRequired from the second step, and renders the screen instead of going on', () => {
    expect(src).toContain('reenrolApi\n      .signInTotp({ challenge, code })');
    expect(src).toContain('if (needsReenrol(result))');
    expect(src).toContain('setReenrol(true)');
    expect(src).toContain('if (reenrol) return <ReEnrol onDone={carryOn} />;');
  });
});
