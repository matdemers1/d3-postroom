// Fixtures shared by the branch and property tests: one per Priority/People/Other branch named in
// PST-T-5.2's doneWhen.
import type { AccountContext, AuthVerdicts, HeaderLike, SignalInput } from '../../src/index.js';

export function header(name: string, value: string): HeaderLike {
  return { name, value };
}

export function account(overrides: Partial<AccountContext> = {}): AccountContext {
  return {
    addresses: ['me@d3cloud.io'],
    replyGraph: [],
    contacts: [],
    pins: { vip: [], blocked: [] },
    ...overrides,
  };
}

export const AUTH_PASS: AuthVerdicts = {
  spf: { result: 'pass' },
  dkim: [{ result: 'pass' }],
  dmarc: { result: 'pass' },
  arc: { result: 'none' },
};

export const AUTH_FAIL: AuthVerdicts = {
  spf: { result: 'fail' },
  dkim: [{ result: 'fail' }],
  dmarc: { result: 'fail' },
  arc: { result: 'none' },
};

export function directMessage(overrides: Partial<SignalInput> = {}): SignalInput {
  return {
    headers: [header('From', 'Jane Doe <jane@example.com>'), header('To', 'me@d3cloud.io'), header('Subject', 'Hi')],
    envelopeFrom: 'jane@example.com',
    authVerdicts: AUTH_PASS,
    account: account(),
    ...overrides,
  };
}
