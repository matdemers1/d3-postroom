// PST-T-16.7 (PST-REQ-197): recovery codes in the web app. Completing setup shows the ten codes
// behind an "I have saved these" checkbox before the wizard; Copy all and Download .txt hand them
// over; sign-in offers a recovery code in place of the TOTP code; and Settings › Account › Sign-in can
// make a new set behind step-up (on Browser sessions until PST-T-17.12).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as apiModule from '../../src/api';
import { ApiError } from '../../src/api';
import { recoveryApi } from '../../src/screens/recovery/api';
import {
  describeRecoveryError,
  displayCode,
  RECOVERY_FILENAME,
  recoveryCodesClipboard,
  recoveryCodesText,
  SAVED_LABEL,
  USE_AUTHENTICATOR_LABEL,
  USE_RECOVERY_LABEL,
} from '../../src/screens/recovery/codes';
import { recoveryStatusLine } from '../../src/settings/recovery-status';

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

const CODES = ['ABCDE-FGHJK', 'MNPQR-STVWX', '01234-56789', 'YZ012-34567', 'AAAAA-BBBBB', 'CCCCC-DDDDD', 'EEEEE-FFFFF', 'GGGGG-HHHHH', 'JJJJJ-KKKKK', 'MMMMM-NNNNN'];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what Copy all and Download .txt hand over', () => {
  it('Copy all is the ten codes, one per line, nothing else', () => {
    expect(recoveryCodesClipboard(CODES)).toBe(CODES.join('\n'));
  });

  it('the .txt names the account and the date, says each works once, and lists every code', () => {
    const text = recoveryCodesText(CODES, { address: 'matt@d3cloud.io', createdAt: new Date('2026-10-01T09:00:00Z') });
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('Postroom recovery codes for matt@d3cloud.io');
    expect(lines[1]).toBe('Issued 2026-10-01');
    expect(text).toMatch(/Each code works once/);
    for (const code of CODES) expect(lines).toContain(code);
    expect(RECOVERY_FILENAME).toMatch(/\.txt$/);
  });

  it('without an address the heading still reads', () => {
    expect(recoveryCodesText(CODES, { createdAt: new Date() }).split('\r\n')[0]).toBe('Postroom recovery codes');
  });

  it('shows a code in two groups of five', () => {
    expect(displayCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
    expect(displayCode('ABCDE-FGHJK')).toBe('ABCDE-FGHJK');
  });
});

// The component itself pulls in @d3cloud/ui's CSS, which Node cannot load, so its contract is read
// from the source; the e2e (account-security.spec.ts) drives it in a browser.
describe('the codes screen', () => {
  const src = read('screens/recovery/RecoveryCodes.tsx');

  it('lists every code, each in its two groups', () => {
    expect(src).toMatch(/codes\.map\(\(code\) => \(\s*<li key=\{code\}>\s*<code>\{displayCode\(code\)\}<\/code>/);
  });

  it('offers Copy all and Download .txt', () => {
    expect(src).toContain("'Copy all'");
    expect(src).toContain('Download .txt');
    expect(src).toContain('recoveryCodesClipboard(codes)');
    expect(src).toContain('RECOVERY_FILENAME');
  });

  it('gates the way on behind an unticked "I have saved these" checkbox', () => {
    expect(SAVED_LABEL).toBe('I have saved these');
    expect(src).toContain('useState(false)');
    expect(src).toContain('label={SAVED_LABEL}');
    expect(src).toContain('disabled={!saved}');
  });
});

describe('setup shows the codes once, then the wizard', () => {
  const src = read('screens/Setup.tsx');

  it('reads the codes from setup/complete and renders them before leaving', () => {
    expect(src).toContain('recoveryApi');
    expect(src).toContain('setRecovery({ codes');
    expect(src).toContain('<RecoveryCodes');
    // Continue is what leaves — still a full load to the wizard (PST-DA-036).
    expect(src).toMatch(/onContinue=\{finish\}/);
    expect(src).toContain('window.location.replace(AFTER_SETUP)');
  });

  it('setup/complete is the same request, read for its recovery codes', async () => {
    const call = vi.spyOn(apiModule, 'call').mockResolvedValue({ ok: true, account: { id: 'a', address: 'm@d3cloud.io' }, recoveryCodes: CODES });
    const result = await recoveryApi.setupComplete({ setupToken: '', enrolToken: 't', code: '123456' });
    expect(call).toHaveBeenCalledWith('POST', '/api/auth/setup/complete', { setupToken: '', enrolToken: 't', code: '123456' });
    expect(result.recoveryCodes).toEqual(CODES);
  });
});

describe('sign-in takes a recovery code in place of the TOTP code', () => {
  const src = read('screens/SignIn.tsx');

  it('offers the switch both ways, and a recovery-code field', () => {
    expect(USE_RECOVERY_LABEL).toBe('Use a recovery code instead');
    expect(USE_AUTHENTICATOR_LABEL).toBe('Use your authenticator instead');
    expect(src).toContain('USE_RECOVERY_LABEL');
    expect(src).toContain('USE_AUTHENTICATOR_LABEL');
    expect(src).toContain('label="Recovery code"');
    // The TOTP field keeps its name: every e2e signs in through it.
    expect(src).toContain('label="Authentication code"');
  });

  it('a used code and a wrong one read the same', () => {
    expect(describeRecoveryError(new ApiError(401, 'invalid_code', {}))).toBe('That recovery code didn’t match, or it’s already been used.');
    expect(describeRecoveryError(new ApiError(429, 'too_many_attempts', {}))).toMatch(/Too many attempts/);
  });
});

describe('Settings › Account › Sign-in: a new set behind step-up', () => {
  it('regenerate is POST /api/auth/recovery-codes; the status is a GET', async () => {
    const call = vi.spyOn(apiModule, 'call').mockResolvedValue({});
    await recoveryApi.regenerate();
    await recoveryApi.status();
    expect(call).toHaveBeenNthCalledWith(1, 'POST', '/api/auth/recovery-codes');
    expect(call).toHaveBeenNthCalledWith(2, 'GET', '/api/auth/recovery-codes');
  });

  it('opens the step-up prompt on step_up_required and retries after the code', () => {
    const src = read('settings/RecoveryCodesSection.tsx');
    expect(src).toContain("caught.code === 'step_up_required'");
    expect(src).toMatch(/\.stepUp\(code\)\s*\.then\(\(\) => regenerate\(\)\)/);
    expect(src).toContain('<RecoveryCodes');
  });

  it('renders on Account, as a row of the Sign-in card after Two-factor (PST-T-17.12)', () => {
    const account = read('screens/ChangePassword.tsx');
    const signIn = account.indexOf('<Section title="Sign-in">');
    const twoFactor = account.indexOf('title="Two-factor authentication"');
    const recovery = account.indexOf('<RecoveryCodesSection />');
    const d3auth = account.indexOf('<AccountD3AuthRow />');
    expect(signIn).toBeGreaterThan(0);
    expect(recovery).toBeGreaterThan(twoFactor);
    expect(twoFactor).toBeGreaterThan(signIn);
    expect(d3auth).toBeGreaterThan(recovery);
    expect(recovery).toBeLessThan(account.indexOf('<Section title="Preferences">'));
    // Browser sessions no longer holds it.
    expect(read('screens/Sessions.tsx')).not.toContain('RecoveryCodesSection');
  });

  it('asks first, then steps up: the confirm dialog, then the code prompt', () => {
    const src = read('settings/RecoveryCodesSection.tsx');
    expect(src).toContain('title="Make new recovery codes?"');
    expect(src).toContain('title="Confirm it is you"');
    expect(src).toContain('Verify and make new codes');
    // The confirm's own button is what calls the server; "Make new codes" in the row only opens it.
    expect(src).toMatch(/setConfirming\(true\);\s*\}\}\s*>\s*Make new codes/);
  });

  it('says how many are left', () => {
    const fmt = (): string => '1 Oct 2026';
    expect(recoveryStatusLine({ total: 10, remaining: 10, createdAt: '2026-10-01T00:00:00Z' }, fmt)).toBe('10 of 10 left · made 1 Oct 2026');
    expect(recoveryStatusLine({ total: 10, remaining: 2, createdAt: '2026-10-01T00:00:00Z' }, fmt)).toMatch(/^2 of 10 left · made 1 Oct 2026\. Running low/);
    expect(recoveryStatusLine({ total: 10, remaining: 0, createdAt: null }, fmt)).toBe('All 10 codes have been used. Make a new set.');
    expect(recoveryStatusLine({ total: 0, remaining: 0, createdAt: null }, fmt)).toMatch(/no recovery codes/);
  });
});
