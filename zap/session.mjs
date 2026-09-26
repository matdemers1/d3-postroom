#!/usr/bin/env node
// Signs an operator in through the real flow and prints the session cookie ZAP scans with
// (PST-T-4.3, PST-REQ-090). An unauthenticated scan of an app that is almost entirely behind a
// sign-in would find the sign-in screen and nothing else.
//
//   POSTROOM_URL=http://127.0.0.1:3300 node zap/session.mjs
//
// On a fresh stack (the nightly job) it runs first-run setup: display name, login, password, then a
// TOTP code computed from the secret setup hands back — the same steps the e2e suite takes in a
// browser. Setup accepts a private client address when SETUP_TOKEN is unset, and a request to the
// published loopback port arrives from the Docker bridge; ZAP_SETUP_TOKEN is sent when set.
//
// On a stack that already has an operator, set ZAP_LOGIN, ZAP_PASSWORD and ZAP_TOTP_SECRET and it
// signs in with password + TOTP instead.
//
// No dependencies: Node's fetch and crypto only, so it runs on a bare runner.
import { createHmac, randomBytes } from 'node:crypto';

const target = new URL(process.env.POSTROOM_URL ?? 'http://127.0.0.1:3300');
const CSRF = { 'x-postroom-csrf': '1' };
const jar = new Map();

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function call(method, path, body) {
  const headers = { accept: 'application/json', ...CSRF };
  if (jar.size > 0) headers.cookie = cookieHeader();
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(new URL(path, target), {
    method,
    headers,
    redirect: 'manual',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const at = pair.indexOf('=');
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1);
    if (value === '' || /max-age=0/i.test(cookie) || /expires=thu, 01 jan 1970/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

// ─── RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as the server's otpauth expects ──────────────────────

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('TOTP secret is not base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

const currentStep = () => Math.floor(Date.now() / 30_000);

/** Waits for the next 30-second step: the server burns every step it accepts. */
async function nextStep(after) {
  while (currentStep() <= after) await new Promise((resolve) => setTimeout(resolve, 500));
  return currentStep();
}

// ─── Sign in ───────────────────────────────────────────────────────────────────────────────────

function fail(message) {
  process.stderr.write(`zap/session.mjs: ${message}\n`);
  process.exit(1);
}

const state = await call('GET', '/api/auth/state');
if (state.status !== 200) fail(`GET /api/auth/state answered ${state.status}`);

if (state.json.setupRequired === true) {
  const password = randomBytes(24).toString('base64url');
  const begin = await call('POST', '/api/auth/setup/begin', {
    displayName: 'ZAP Scanner',
    login: 'zap',
    password,
    ...(process.env.ZAP_SETUP_TOKEN ? { setupToken: process.env.ZAP_SETUP_TOKEN } : {}),
  });
  if (begin.status !== 200) fail(`setup/begin answered ${begin.status}: ${JSON.stringify(begin.json)}`);
  const { enrolToken, secret } = begin.json;
  const complete = await call('POST', '/api/auth/setup/complete', {
    enrolToken,
    code: totp(secret, currentStep()),
    ...(process.env.ZAP_SETUP_TOKEN ? { setupToken: process.env.ZAP_SETUP_TOKEN } : {}),
  });
  if (complete.status !== 200) fail(`setup/complete answered ${complete.status}: ${JSON.stringify(complete.json)}`);
} else {
  const { ZAP_LOGIN: login, ZAP_PASSWORD: password, ZAP_TOTP_SECRET: secret } = process.env;
  if (!login || !password || !secret) {
    fail('this stack already has an operator: set ZAP_LOGIN, ZAP_PASSWORD and ZAP_TOTP_SECRET, or scan a fresh stack');
  }
  let step = currentStep();
  for (let attempt = 0; ; attempt++) {
    const first = await call('POST', '/api/auth/signin', { login, password });
    if (first.status !== 200) fail(`signin answered ${first.status}: ${JSON.stringify(first.json)}`);
    const second = await call('POST', '/api/auth/signin/totp', { challenge: first.json.challenge, code: totp(secret, step) });
    if (second.status === 200) break;
    // The current step may already be burnt by an earlier sign-in; the next one is not.
    if (attempt >= 1) fail(`signin/totp answered ${second.status}: ${JSON.stringify(second.json)}`);
    step = await nextStep(step);
  }
}

// A scan that silently lost its session would scan the sign-in screen and call everything clean.
const me = await call('GET', '/api/auth/state');
if (me.status !== 200 || me.json.signedIn !== true) fail('no session after signing in');
const mailboxes = await call('GET', '/api/mailboxes');
if (mailboxes.status !== 200) fail(`GET /api/mailboxes answered ${mailboxes.status} with the new session`);

// To run.sh's $(...) — the scanner needs the cookie; nothing logs it. The stack is thrown away.
process.stdout.write(cookieHeader()); // nosemgrep: postroom.secret-in-log
