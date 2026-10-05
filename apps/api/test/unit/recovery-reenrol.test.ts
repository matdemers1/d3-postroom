// PST-T-16.26 (PST-REQ-200, PST-REQ-197), without a database: the route logic over a fake Db.
// - A sign-in challenge claims its attempt BEFORE a recovery code is hashed, and only one code check
//   runs per challenge at a time, so five guesses fired at once cost one check, not five.
// - A session marked as signed in with a recovery code answers 403 totp_reenrol_required on every
//   step-up-gated action (and on step-up itself) until it re-enrols.
// - Re-enrolment: begin makes a new secret bound to the session; complete proves it, replaces the
//   account's secret, issues ten fresh recovery codes, marks the session TOTP, and audits all three.
// The integration twin (auth-reenrol.test.ts) runs the same flow against PostgreSQL in CI.
import type { Db } from '@postroom/db';
import { Secret, TOTP } from 'otpauth';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { ApiDeps } from '../../src/deps.js';
import { recoveryCheckStats } from '../../src/auth/recovery.js';
import { runtimeFor } from '../../src/auth/runtime.js';
import { metaOf } from '../../src/auth/sessions.js';
import { request } from '../loopback.js';

const CSRF = { 'x-postroom-csrf': '1' };
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const COOKIE = 'postroom_session=unit-session-token';
const OTHER_SESSION_A = '00000000-0000-4000-8000-0000000000a1';
const OTHER_SESSION_B = '00000000-0000-4000-8000-0000000000b2';

interface Audit {
  action: string;
  before?: unknown;
  after?: unknown;
}

interface Fake {
  db: Db;
  audits: Audit[];
  account: Record<string, unknown>;
  session: { secondFactor: string | null; stepUpAt: Date | null };
  created: { codeHash: string }[];
  findManyCalls: number;
  /** The account's other sessions; session.deleteMany removes from here (PST-T-16.28). */
  otherSessions: string[];
}

/** A Db with just what the auth routes touch. `codes` is what recoveryCode.findMany answers, after `delayMs`. */
function fakeDb(opts: { secondFactor?: string | null; codes?: { id: string; codeHash: string }[]; delayMs?: number } = {}): Fake {
  const audits: Audit[] = [];
  const account: Record<string, unknown> = {
    id: ACCOUNT_ID,
    displayName: 'Matt',
    isAdmin: true,
    totpEnabled: true,
    totpSecret: new Uint8Array([1, 2, 3]),
    totpLastStep: null,
    disabledAt: null,
    passwordHash: 'x',
  };
  const session = { secondFactor: opts.secondFactor ?? null, stepUpAt: null as Date | null };
  const created: { codeHash: string }[] = [];
  const fake: Fake = { db: {} as Db, audits, account, session, created, findManyCalls: 0, otherSessions: [OTHER_SESSION_A, OTHER_SESSION_B] };
  const db = {
    account: {
      count: () => Promise.resolve(1),
      findUnique: () => Promise.resolve(account),
      findUniqueOrThrow: () => Promise.resolve(account),
      update: ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(account, data);
        return Promise.resolve(account);
      },
    },
    recoveryCode: {
      findMany: async () => {
        fake.findManyCalls += 1;
        if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs));
        return opts.codes ?? [];
      },
      deleteMany: () => Promise.resolve({ count: 10 }),
      createMany: ({ data }: { data: { codeHash: string }[] }) => {
        created.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
    session: {
      findUnique: () =>
        Promise.resolve({
          id: SESSION_ID,
          accountId: ACCOUNT_ID,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
          stepUpAt: session.stepUpAt,
          method: 'password',
          roles: [],
          oidcIssuer: null,
          oidcSubject: null,
          secondFactor: session.secondFactor,
          native: false,
          account: { displayName: 'Matt', isAdmin: true, totpEnabled: true, disabledAt: null },
        }),
      update: () => Promise.resolve({}),
      findMany: ({ where }: { where: { accountId: string; id: { not: string } } }) =>
        Promise.resolve(where.accountId === ACCOUNT_ID ? fake.otherSessions.filter((id) => id !== where.id.not).map((id) => ({ id })) : []),
      deleteMany: ({ where }: { where: { id: { in: string[] } } }) => {
        const before = fake.otherSessions.length;
        fake.otherSessions = fake.otherSessions.filter((id) => !where.id.in.includes(id));
        return Promise.resolve({ count: before - fake.otherSessions.length });
      },
      updateMany: ({ where, data }: { where: { secondFactor?: string }; data: { secondFactor: string } }) => {
        if (where.secondFactor !== undefined && where.secondFactor !== session.secondFactor) return Promise.resolve({ count: 0 });
        session.secondFactor = data.secondFactor;
        return Promise.resolve({ count: 1 });
      },
    },
    address: { findFirst: () => Promise.resolve(null) },
    auditEvent: {
      create: ({ data }: { data: Audit }) => {
        audits.push(data);
        return Promise.resolve(data);
      },
      count: () => Promise.resolve(1),
    },
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };
  fake.db = db as unknown as Db;
  return fake;
}

function depsFor(db: Db): ApiDeps {
  return {
    db,
    env: {},
    config: {
      webDist: undefined,
      webOrigin: 'http://127.0.0.1:3399',
      revision: 'x',
      passwordPepper: 'unit-pepper-0123456789abcdef',
      sessionSecret: 'unit-session-secret-0123456789abcdef',
      kekBase64: Buffer.alloc(32, 7).toString('base64'),
      domain: 'd3cloud.io',
    },
  };
}

function totpNow(secret: string, at = Date.now()): string {
  return new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate({ timestamp: at });
}

describe('the session remembers how its second factor was satisfied', () => {
  it('reads second_factor back as totp, recovery_code or absent', () => {
    const row = { method: 'password', roles: [], oidcIssuer: null, oidcSubject: null };
    expect(metaOf({ ...row, secondFactor: 'recovery_code' }).secondFactor).toBe('recovery_code');
    expect(metaOf({ ...row, secondFactor: 'totp' }).secondFactor).toBe('totp');
    expect(metaOf({ ...row, secondFactor: null })).not.toHaveProperty('secondFactor');
    expect(metaOf({ ...row, secondFactor: 'nonsense' })).not.toHaveProperty('secondFactor');
  });
});

describe('a sign-in challenge claims the attempt before any recovery code is hashed', () => {
  it('five recovery-shaped guesses fired at once: one check runs, the rest get 429 without hashing', async () => {
    const fake = fakeDb({ codes: [], delayMs: 250 });
    const deps = depsFor(fake.db);
    const app = createApp(deps);
    const rt = runtimeFor(deps);
    rt.challenges.set('ch-5', { accountId: ACCOUNT_ID, login: 'matt', exp: Date.now() + 60_000, attempts: 0, checking: false });
    const checksBefore = recoveryCheckStats.checks;

    const guesses = ['AAAAA-AAAAA', 'BBBBB-BBBBB', 'CCCCC-CCCCC', 'DDDDD-DDDDD', 'EEEEE-EEEEE'];
    const results = await Promise.all(
      guesses.map((code) => request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge: 'ch-5', code })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([401, 429, 429, 429, 429]);
    for (const r of results.filter((x) => x.status === 429)) {
      expect(r.body).toMatchObject({ error: 'too_many_attempts', reason: 'check_in_flight' });
      expect(r.headers['retry-after']).toBe('1');
    }
    // One request reached the code store, and one check ran.
    expect(fake.findManyCalls).toBe(1);
    expect(recoveryCheckStats.checks - checksBefore).toBe(1);
    expect(rt.challenges.get('ch-5', Date.now())).toMatchObject({ attempts: 1, checking: false });
    expect(fake.audits.filter((a) => a.action === 'auth.signin.rejected')).toHaveLength(1);
  });

  it('counts the attempt while the check is still running: the fifth burns the challenge before it hashes', async () => {
    const fake = fakeDb({ codes: [], delayMs: 150 });
    const deps = depsFor(fake.db);
    const app = createApp(deps);
    const rt = runtimeFor(deps);
    rt.challenges.set('ch-cap', { accountId: ACCOUNT_ID, login: 'matt', exp: Date.now() + 60_000, attempts: 4, checking: false });
    const inFlight = request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge: 'ch-cap', code: 'AAAAA-AAAAA' }).then((r) => r);
    // While it is still waiting on the code store, the challenge is already gone…
    await new Promise((r) => setTimeout(r, 60));
    expect(rt.challenges.get('ch-cap', Date.now())).toBeUndefined();
    const late = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge: 'ch-cap', code: 'BBBBB-BBBBB' });
    expect(late.status).toBe(401);
    expect(late.body).toEqual({ error: 'challenge_expired' });
    // …and the claimed check still finishes, refused.
    expect((await inFlight).status).toBe(401);
    expect(fake.findManyCalls).toBe(1);
  });

  it('counts guesses toward the (login, IP) throttle before checking them', async () => {
    const fake = fakeDb({ codes: [] });
    const deps = depsFor(fake.db);
    const app = createApp(deps);
    const rt = runtimeFor(deps);
    for (let i = 0; i < 5; i++) {
      rt.challenges.set(`ch-t${String(i)}`, { accountId: ACCOUNT_ID, login: 'matt', exp: Date.now() + 60_000, attempts: 0, checking: false });
      expect((await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge: `ch-t${String(i)}`, code: 'AAAAA-AAAAA' })).status).toBe(401);
    }
    rt.challenges.set('ch-t5', { accountId: ACCOUNT_ID, login: 'matt', exp: Date.now() + 60_000, attempts: 0, checking: false });
    const before = fake.findManyCalls;
    const throttled = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge: 'ch-t5', code: 'AAAAA-AAAAA' });
    expect(throttled.status).toBe(429);
    expect(fake.findManyCalls).toBe(before);
  });
});

describe('a recovery-code session must re-enrol before any step-up action (PST-REQ-200)', () => {
  it('answers 403 totp_reenrol_required on step-up-gated routes and on step-up itself, audited', async () => {
    const fake = fakeDb({ secondFactor: 'recovery_code' });
    const app = createApp(depsFor(fake.db));

    const state = await request(app).get('/api/auth/state').set('cookie', COOKIE);
    expect(state.body).toMatchObject({ signedIn: true, reenrolRequired: true });

    const regen = await request(app).post('/api/auth/recovery-codes').set(CSRF).set('cookie', COOKIE);
    expect(regen.status).toBe(403);
    expect(regen.body).toEqual({ error: 'totp_reenrol_required' });
    const revoke = await request(app).delete('/api/auth/sessions').set(CSRF).set('cookie', COOKIE);
    expect(revoke.status).toBe(403);
    expect(revoke.body).toEqual({ error: 'totp_reenrol_required' });
    const stepUp = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', COOKIE).send({ code: '123456' });
    expect(stepUp.status).toBe(403);
    expect(stepUp.body).toEqual({ error: 'totp_reenrol_required' });
    const password = await request(app)
      .post('/api/auth/password')
      .set(CSRF)
      .set('cookie', COOKIE)
      .send({ currentPassword: 'x', newPassword: 'a fresh strong passphrase 2026', code: '123456' });
    expect(password.status).toBe(403);
    expect(password.body).toEqual({ error: 'totp_reenrol_required' });

    const denied = fake.audits.filter((a) => a.action === 'authz.denied');
    expect(denied).toHaveLength(4);
    for (const d of denied) expect(d.after).toMatchObject({ reason: 'totp_reenrol_required' });
  });

  it('a TOTP session is only asked for the usual step-up', async () => {
    const fake = fakeDb({ secondFactor: 'totp' });
    const app = createApp(depsFor(fake.db));
    const state = await request(app).get('/api/auth/state').set('cookie', COOKIE);
    expect(state.body).toMatchObject({ signedIn: true, reenrolRequired: false });
    const regen = await request(app).post('/api/auth/recovery-codes').set(CSRF).set('cookie', COOKIE);
    expect(regen.status).toBe(403);
    expect(regen.body).toEqual({ error: 'step_up_required' });
    const begin = await request(app).post('/api/auth/totp/reenrol/begin').set(CSRF).set('cookie', COOKIE);
    expect(begin.status).toBe(409);
    expect(begin.body).toEqual({ error: 'reenrol_not_required' });
  });
});

describe('re-enrolment replaces the authenticator, the recovery codes and the session mark', () => {
  it('begin → a wrong code → the right code: new secret sealed, ten codes once, three audits', async () => {
    const fake = fakeDb({ secondFactor: 'recovery_code' });
    const app = createApp(depsFor(fake.db));
    const oldSealed = fake.account['totpSecret'];

    const expired = await request(app).post('/api/auth/totp/reenrol/complete').set(CSRF).set('cookie', COOKIE).send({ code: '123456' });
    expect(expired.status).toBe(400);
    expect(expired.body).toEqual({ error: 'reenrol_expired' });

    const begin = await request(app).post('/api/auth/totp/reenrol/begin').set(CSRF).set('cookie', COOKIE);
    expect(begin.status).toBe(200);
    expect(begin.headers['cache-control']).toBe('no-store');
    const { secret, otpauthUri } = begin.body as { secret: string; otpauthUri: string };
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/Postroom:/);
    expect(fake.audits.map((a) => a.action)).toContain('auth.totp.reenrol.begin');
    // Nothing on the account changed yet.
    expect(fake.account['totpSecret']).toBe(oldSealed);

    const wrong = await request(app)
      .post('/api/auth/totp/reenrol/complete')
      .set(CSRF)
      .set('cookie', COOKIE)
      .send({ code: totpNow(secret, Date.now() + 10 * 60_000) });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error: 'invalid_code' });
    expect(fake.session.secondFactor).toBe('recovery_code');

    const done = await request(app).post('/api/auth/totp/reenrol/complete').set(CSRF).set('cookie', COOKIE).send({ code: totpNow(secret) });
    expect(done.status).toBe(200);
    expect(done.headers['cache-control']).toBe('no-store');
    const codes = (done.body as { recoveryCodes: string[] }).recoveryCodes;
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(fake.created).toHaveLength(10);
    for (const row of fake.created) expect(row.codeHash).toMatch(/^\$argon2id\$/);

    expect(fake.account['totpSecret']).not.toBe(oldSealed);
    expect(fake.account['totpSecret']).toBeInstanceOf(Uint8Array);
    expect(typeof fake.account['totpLastStep']).toBe('bigint');
    expect(fake.session.secondFactor).toBe('totp');
    const actions = fake.audits.map((a) => a.action);
    for (const action of ['auth.totp.invalidate', 'auth.totp.enrol', 'auth.recovery-codes.regenerate']) expect(actions).toContain(action);
    expect(fake.audits.find((a) => a.action === 'auth.recovery-codes.regenerate')?.after).toMatchObject({ count: 10, reason: 'reenrol' });
    // Neither the secret nor a code is ever written into the audit trail.
    const text = JSON.stringify(fake.audits);
    expect(text).not.toContain(secret);
    for (const code of codes) expect(text).not.toContain(code);

    // Done once: the session is TOTP now, so a second complete has nothing to do.
    const again = await request(app).post('/api/auth/totp/reenrol/complete').set(CSRF).set('cookie', COOKIE).send({ code: totpNow(secret) });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'reenrol_not_required' });
  }, 30_000);
});

describe('second-factor hardening (PST-T-16.28)', () => {
  it('completing re-enrolment ends every other session of the account, audited as "sign out everywhere"', async () => {
    const fake = fakeDb({ secondFactor: 'recovery_code' });
    const app = createApp(depsFor(fake.db));
    const begin = await request(app).post('/api/auth/totp/reenrol/begin').set(CSRF).set('cookie', COOKIE);
    const { secret } = begin.body as { secret: string };
    const done = await request(app).post('/api/auth/totp/reenrol/complete').set(CSRF).set('cookie', COOKIE).send({ code: totpNow(secret) });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ endedSessions: 2 });
    expect(fake.otherSessions).toEqual([]);
    const revoked = fake.audits.filter((a) => a.action === 'auth.session.revoke-others');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.after).toEqual({ ended: [OTHER_SESSION_A, OTHER_SESSION_B], reason: 'reenrol' });
  }, 30_000);

  it('a wrong code ends no session', async () => {
    const fake = fakeDb({ secondFactor: 'recovery_code' });
    const app = createApp(depsFor(fake.db));
    const begin = await request(app).post('/api/auth/totp/reenrol/begin').set(CSRF).set('cookie', COOKIE);
    const { secret } = begin.body as { secret: string };
    const wrong = await request(app)
      .post('/api/auth/totp/reenrol/complete')
      .set(CSRF)
      .set('cookie', COOKIE)
      .send({ code: totpNow(secret, Date.now() + 10 * 60_000) });
    expect(wrong.status).toBe(401);
    expect(fake.otherSessions).toHaveLength(2);
    expect(fake.audits.map((a) => a.action)).not.toContain('auth.session.revoke-others');
  });

  it('a repeat begin answers the same pending secret with no new audit row; the sixth in the window is 429', async () => {
    const fake = fakeDb({ secondFactor: 'recovery_code' });
    const app = createApp(depsFor(fake.db));
    const secrets = new Set<string>();
    const expiries = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post('/api/auth/totp/reenrol/begin').set(CSRF).set('cookie', COOKIE);
      expect(res.status).toBe(200);
      const body = res.body as { secret: string; expiresAt: string };
      secrets.add(body.secret);
      expiries.add(body.expiresAt);
    }
    expect(secrets.size).toBe(1);
    expect(expiries.size).toBe(1);
    expect(fake.audits.filter((a) => a.action === 'auth.totp.reenrol.begin')).toHaveLength(1);
    expect(fake.audits.filter((a) => a.action === 'auth.totp.reenrol.resume')).toHaveLength(4);

    const sixth = await request(app).post('/api/auth/totp/reenrol/begin').set(CSRF).set('cookie', COOKIE);
    expect(sixth.status).toBe(429);
    expect(sixth.body).toMatchObject({ error: 'too_many_attempts' });
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    expect(fake.audits.filter((a) => a.action === 'auth.totp.reenrol.begin')).toHaveLength(1);
    expect(fake.audits.filter((a) => a.action === 'auth.totp.reenrol.resume')).toHaveLength(4);
  });

  it('a repeat begin does not reset the attempts a pending enrolment has used', async () => {
    const fake = fakeDb({ secondFactor: 'recovery_code' });
    const deps = depsFor(fake.db);
    const app = createApp(deps);
    const rt = runtimeFor(deps);
    await request(app).post('/api/auth/totp/reenrol/begin').set(CSRF).set('cookie', COOKIE);
    const pending = rt.reenrols.get(SESSION_ID, Date.now());
    expect(pending).toBeDefined();
    if (pending !== undefined) pending.attempts = 3;
    await request(app).post('/api/auth/totp/reenrol/begin').set(CSRF).set('cookie', COOKIE);
    expect(rt.reenrols.get(SESSION_ID, Date.now())).toMatchObject({ attempts: 3 });
  });
});
