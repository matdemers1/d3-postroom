// The D3 App contract's conformance suite needs a running Postroom and an account it can sign in to
// (PST-T-19.5). This boots the api on a fresh database cut from DATABASE_URL, with one administrator
// whose TOTP secret is generated here — the instance's only owner, for deletion.last-owner — plus an
// unused member invite (invite.accept) and a disposable member with TOTP (deletion.schedules,
// PST-T-20.2/20.3), and writes the suite's arguments to CONFORMANCE_OUT:
//
//   DATABASE_URL=… CONFORMANCE_OUT=/tmp/args.json node --conditions=source --import tsx test/conformance-server.ts
//
// Plain http on 127.0.0.1, so the suite runs with --allow-http — for CI and a laptop, never a host.
import { writeFileSync } from 'node:fs';
import { seed } from '@postroom/db';
import { createTestDatabase } from '@postroom/db/testing';
import { createApp } from '../src/app.js';
import { hashInviteToken, INVITE_TTL_MS, newInviteToken } from '../src/auth/account-lifecycle.js';
import { baseConfig, createAccount, TestClock } from './integration/helpers.js';

const url = process.env['DATABASE_URL'];
const out = process.env['CONFORMANCE_OUT'];
const port = Number(process.env['PORT'] ?? '3477');
if (url === undefined || out === undefined) {
  process.stderr.write('DATABASE_URL and CONFORMANCE_OUT are required\n');
  process.exit(2);
}

const testDb = await createTestDatabase(url, 'conformance');
const db = testDb.db;
await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
const password = `conformance ${Math.random().toString(36).slice(2)} staple`;
const { totpSecret } = await createAccount(db, { login: 'conformance', password, isAdmin: true, displayName: 'Conformance' });
// Not an admin: the conformance account must stay the instance's last owner.
const inviteToken = newInviteToken();
await db.accountInvite.create({ data: { tokenHash: hashInviteToken(inviteToken), localPart: 'invited', expiresAt: new Date(Date.now() + INVITE_TTL_MS) } });
const deletePassword = `disposable ${Math.random().toString(36).slice(2)} staple`;
const disposable = await createAccount(db, { login: 'disposable', password: deletePassword, displayName: 'Disposable' });
const origin = `http://127.0.0.1:${port}`;
const app = createApp({ db, env: {}, config: baseConfig(new TestClock(), { webOrigin: origin, relayAllowLoopbackHttp: true }) });

const server = app.listen(port, '127.0.0.1', () => {
  writeFileSync(
    out,
    `${JSON.stringify({
      base: origin,
      product: 'postroom',
      email: 'conformance@d3cloud.io',
      password,
      totpSecret,
      inviteToken,
      deleteEmail: 'disposable@d3cloud.io',
      deletePassword,
      deleteTotpSecret: disposable.totpSecret,
    })}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`conformance server on ${origin}\n`);
});

const stop = (): void => {
  server.close();
  void testDb.drop().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
