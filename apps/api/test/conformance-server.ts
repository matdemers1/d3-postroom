// The D3 App contract's conformance suite needs a running Postroom and an account it can sign in to
// (PST-T-19.5). This boots the api on a fresh database cut from DATABASE_URL, with one administrator
// whose TOTP secret is generated here, and writes the suite's arguments to CONFORMANCE_OUT:
//
//   DATABASE_URL=… CONFORMANCE_OUT=/tmp/args.json node --conditions=source --import tsx test/conformance-server.ts
//
// Plain http on 127.0.0.1, so the suite runs with --allow-http — for CI and a laptop, never a host.
import { writeFileSync } from 'node:fs';
import { seed } from '@postroom/db';
import { createTestDatabase } from '@postroom/db/testing';
import { createApp } from '../src/app.js';
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
const origin = `http://127.0.0.1:${port}`;
const app = createApp({ db, env: {}, config: baseConfig(new TestClock(), { webOrigin: origin }) });

const server = app.listen(port, '127.0.0.1', () => {
  writeFileSync(
    out,
    `${JSON.stringify({ base: origin, product: 'postroom', email: 'conformance@d3cloud.io', password, totpSecret })}\n`,
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
