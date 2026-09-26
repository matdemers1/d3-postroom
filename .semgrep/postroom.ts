// Rule tests for .semgrep/postroom.yml. Run: semgrep --test .semgrep/
// Every rule has at least one case it must flag (ruleid) and one it must leave alone (ok).
import * as cp from 'node:child_process';
import { exec, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:tls';

declare const req: { query: Record<string, string>; params: Record<string, string>; body: { name: string }; get(h: string): string | undefined };
declare const res: {
  send(b: unknown): void;
  write(b: unknown): void;
  end(b?: unknown): void;
  json(b: unknown): void;
  cookie(n: string, v: string, o?: object): void;
};
declare const db: { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown>; $executeRawUnsafe(q: string, ...v: unknown[]): Promise<unknown>; $queryRaw(q: TemplateStringsArray, ...v: unknown[]): Promise<unknown> };
declare const Prisma: { raw(q: string): unknown };
declare const socket: { write(s: string): void; end(s?: string): void };
declare const password: string, appPassword: string, session: { token: string }, user: string, table: string, host: string, tag: string;

// ─── postroom.dynamic-code ───────────────────────────────────────────────────
// ruleid: postroom.dynamic-code
eval(req.body.name);
// ruleid: postroom.dynamic-code
const fn = new Function('a', 'return a');
// ruleid: postroom.dynamic-code
setTimeout('alert(1)', 10);
// ok: postroom.dynamic-code
setTimeout(() => undefined, 10);

// ─── postroom.shell-command-injection ────────────────────────────────────────
// ruleid: postroom.shell-command-injection
exec(`pg_dump ${user}`);
// ruleid: postroom.shell-command-injection
cp.execSync('pg_dump ' + user);
// ruleid: postroom.shell-command-injection
spawn('pg_dump', [user], { shell: true });
// ok: postroom.shell-command-injection
execFile('pg_dump', ['--format=custom', user]);
// ok: postroom.shell-command-injection
spawn('pg_restore', ['--no-owner', user], { stdio: 'pipe' });

// ─── postroom.reflected-user-input ───────────────────────────────────────────
// ruleid: postroom.reflected-user-input
res.send(`<p>Hello ${req.query['name']}</p>`);
// ruleid: postroom.reflected-user-input
res.write(req.body.name);
// ruleid: postroom.reflected-user-input
res.end('agent: ' + req.get('user-agent'));
// ok: postroom.reflected-user-input
res.json({ name: req.body.name });
// ok: postroom.reflected-user-input
res.send('<p>fixed text</p>');
// ok: postroom.reflected-user-input
process.stderr.write(`${JSON.stringify({ event: 'csrf-refused', origin: req.get('origin') ?? null })}\n`);

// ─── postroom.secret-in-log ──────────────────────────────────────────────────
// ruleid: postroom.secret-in-log
console.log('signing in with', password);
// ruleid: postroom.secret-in-log
console.error(`created ${appPassword}`);
// ruleid: postroom.secret-in-log
process.stderr.write(JSON.stringify({ event: 'x', token: session.token }));
// ok: postroom.secret-in-log
console.log('signed in', user);
// ok: postroom.secret-in-log
process.stderr.write(JSON.stringify({ event: 'kek-invalid' }));

// ─── postroom.raw-sql-interpolated ───────────────────────────────────────────
// ruleid: postroom.raw-sql-interpolated
await db.$queryRawUnsafe(`SELECT * FROM ${table}`);
// ruleid: postroom.raw-sql-interpolated
await db.$executeRawUnsafe('DELETE FROM message WHERE id = ' + user);
// ruleid: postroom.raw-sql-interpolated
Prisma.raw(table);
// ok: postroom.raw-sql-interpolated
await db.$queryRawUnsafe('SELECT 1 WHERE $1 = $1', user);
// ok: postroom.raw-sql-interpolated
await db.$queryRaw`SELECT * FROM message WHERE id = ${user}`;

// ─── postroom.insecure-randomness ────────────────────────────────────────────
// (paths.include scopes this to apps/*/src and packages/*/src; `semgrep --test` applies the rule
// to this file regardless.)
// ruleid: postroom.insecure-randomness
const weak = Math.random().toString(36).slice(2);
// ok: postroom.insecure-randomness
const strong = randomBytes(16).toString('base64url');
// ok: postroom.insecure-randomness
const jitter = (random: () => number = Math.random): number => random() * 1000;

// ─── postroom.tls-verification-disabled ──────────────────────────────────────
// ruleid: postroom.tls-verification-disabled
connect({ host, port: 993, rejectUnauthorized: false });
// ruleid: postroom.tls-verification-disabled
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
// ok: postroom.tls-verification-disabled
connect({ host, port: 993, servername: host, minVersion: 'TLSv1.2' });

// ─── postroom.bare-lf-on-the-wire ────────────────────────────────────────────
// ruleid: postroom.bare-lf-on-the-wire
socket.write('220 mx.d3cloud.io ESMTP\n');
// ruleid: postroom.bare-lf-on-the-wire
socket.write(`${tag} OK done\n`);
// ok: postroom.bare-lf-on-the-wire
socket.write('220 mx.d3cloud.io ESMTP\r\n');
// ok: postroom.bare-lf-on-the-wire
socket.end(`${tag} BYE\r\n`);
// ok: postroom.bare-lf-on-the-wire
process.stderr.write('usage: dkim-keys <domain>\n');

// ─── postroom.web-third-party-request ────────────────────────────────────────
// ruleid: postroom.web-third-party-request
await fetch('https://telemetry.example.com/collect', { method: 'POST' });
// ruleid: postroom.web-third-party-request
await fetch(`//cdn.example.com/lib.js`);
// ruleid: postroom.web-third-party-request
navigator.sendBeacon('/api/beacon', 'x');
// ok: postroom.web-third-party-request
await fetch('/api/auth/state', { credentials: 'same-origin' });

// ─── postroom.cookie-without-httponly ────────────────────────────────────────
// ruleid: postroom.cookie-without-httponly
res.cookie('postroom_session', 'v');
// ruleid: postroom.cookie-without-httponly
res.cookie('postroom_session', 'v', { sameSite: 'lax', secure: true });
// ok: postroom.cookie-without-httponly
res.cookie('postroom_session', 'v', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });

void [fn, weak, strong, jitter];
