// PST-T-3.12's exit demo: HTML mail renders on the usercontent origin, in a sandboxed frame, under a
// strict CSP — and "Script and onerror payloads do not run; no request reaches sender hosts."
// (PST-REQ-081, PST-REQ-082)
//
// A local HTTP listener stands in for the sender's server. The message points everything at it —
// a <script> that would fetch it, an onerror that would fetch it, an <svg onload>, a javascript:
// link, a remote <img>, a CSS url() and an @import. Until "Load images" the listener must see
// NOTHING; after, it must see only the api's image proxy (its User-Agent, no Referer), never the
// browser. No dialog opens, no CSP violation is reported, no request leaves the browser for the
// listener.
//
// Where the listener lives: the api fetches it through the proxy, so the api must reach it. Against
// a locally started api that is 127.0.0.1. Against the compose stack (CI), the api is in a
// container, so the message names host.docker.internal (docker-compose.e2e.yml maps it to the
// runner and lets the proxy reach a private address, e2e only). E2E_PIXEL_HOST overrides both.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, seedMail, signInCookies, tag } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

const PIXEL_HOST = process.env['E2E_PIXEL_HOST'] ?? (process.env['CI'] === undefined ? '127.0.0.1' : 'host.docker.internal');
/** A real 1×1 PNG, so the proxy's type sniffing accepts it. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
let listener: Server;
let port = 0;
const hits: { url: string; headers: IncomingHttpHeaders }[] = [];

test.beforeAll(async ({ playwright }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  cookies = await signInCookies(api, await ensureOperator(api));
  listener = createServer((req, res) => {
    hits.push({ url: req.url ?? '', headers: req.headers });
    if (req.url?.startsWith('/pixel.png') === true) res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) }).end(PNG);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => listener.listen(0, '0.0.0.0', resolve));
  port = (listener.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await api.dispose();
  await new Promise<void>((resolve) => listener.close(() => { resolve(); }));
});

test.beforeEach(async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the frame is the same at every width; once is enough');
  await context.addCookies(cookies);
});

interface Watch {
  dialogs: string[];
  browserToSender: string[];
  cspConsole: string[];
  cspReports: string[];
  proxied: { url: string; status: number }[];
}

function watch(page: Page): Watch {
  const w: Watch = { dialogs: [], browserToSender: [], cspConsole: [], cspReports: [], proxied: [] };
  page.on('dialog', (dialog) => {
    w.dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.port === String(port)) w.browserToSender.push(req.url());
    if (url.pathname === '/csp-report') w.cspReports.push(req.postData() ?? '');
  });
  page.on('response', (res) => {
    if (new URL(res.url()).pathname === '/img') w.proxied.push({ url: res.url(), status: res.status() });
  });
  page.on('console', (msg) => {
    if (/Content.Security.Policy/i.test(msg.text())) w.cspConsole.push(msg.text());
  });
  return w;
}

const row = (page: Page, subject: string) => page.getByRole('option', { name: new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });

test('scripts and handlers never run, and nothing reaches the sender until Load images — then only the proxy does', async ({ page }) => {
  const at = `http://${PIXEL_HOST}:${String(port)}`;
  const t = tag();
  const html = [
    '<p id="rendered">Rendered paragraph</p>',
    `<script>alert('script'); fetch('${at}/script')</script>`,
    `<img src=x onerror="alert('onerror'); fetch('${at}/onerror')">`,
    `<svg onload="alert('svg')"><circle r="1"/></svg>`,
    `<a id="jslink" href="javascript:alert('link')">js link</a>`,
    `<a id="oklink" href="https://example.com/">ok link</a>`,
    `<img id="remote" alt="remote pixel" src="${at}/pixel.png?who=img">`,
    `<div id="styled" style="background:url(${at}/bg.png); color: red">styled</div>`,
    `<style>@import url(${at}/import.css); p { color: blue }</style>`,
  ].join('\n');
  const [m] = await seedMail(api, [{ subject: `HTML render ${t}`, text: null, html }]);
  if (m === undefined) throw new Error('seed returned nothing');

  const w = watch(page);
  await page.goto('/');
  await row(page, m.subject).click();
  await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();
  await expect(page.getByTestId('html-placeholder')).toContainText('HTML version only');

  // The frame: another origin, sandboxed without scripts or same-origin, no referrer.
  const frameEl = page.getByTestId('message-html');
  await expect(frameEl).toBeVisible();
  const src = (await frameEl.getAttribute('src')) ?? '';
  expect(new URL(src).origin).not.toBe(new URL(page.url()).origin);
  const sandbox = (await frameEl.getAttribute('sandbox')) ?? 'missing';
  expect(sandbox.split(/\s+/)).not.toContain('allow-scripts');
  expect(sandbox.split(/\s+/)).not.toContain('allow-same-origin');
  expect(await frameEl.getAttribute('referrerpolicy')).toBe('no-referrer');

  const frame = page.frameLocator('[data-testid="message-html"]');
  await expect(frame.locator('#rendered')).toHaveText('Rendered paragraph');
  await expect(frame.locator('#styled')).toHaveText('styled');
  await expect(frame.locator('#jslink')).not.toHaveAttribute('href', /.*/);
  await expect(frame.locator('#oklink')).toHaveAttribute('target', '_blank');
  await expect(frame.locator('#oklink')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(frame.locator('script, svg, style:has-text("import")')).toHaveCount(0);
  await expect(frame.locator('#remote')).toHaveAttribute('data-src', `${at}/pixel.png?who=img`);

  // Give anything that could fire a moment to do it.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1_000);
  expect(w.dialogs).toEqual([]);
  expect(hits).toEqual([]);
  expect(w.browserToSender).toEqual([]);
  expect(w.cspConsole).toEqual([]);
  expect(w.cspReports).toEqual([]);
  expect(await page.evaluate(() => (globalThis as unknown as { pwned?: unknown }).pwned)).toBeUndefined();

  // Remote images: blocked, said so, and loaded only on request — through the proxy.
  const bar = page.getByTestId('remote-images-blocked');
  await expect(bar).toContainText('Remote images blocked');
  await bar.getByRole('button', { name: 'Load images' }).click();
  await expect(bar).toHaveCount(0);
  await expect(frame.locator('#remote')).toHaveAttribute('src', /\/img\?u=/);
  await expect.poll(() => hits.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(500);

  expect(w.proxied.length).toBeGreaterThan(0);
  expect(w.proxied.every((p) => p.status === 200)).toBe(true);
  expect(hits.map((h) => h.url)).toEqual(['/pixel.png?who=img']);
  for (const h of hits) {
    expect(h.headers['user-agent']).toMatch(/^Postroom-ImageProxy\//);
    expect(h.headers['referer']).toBeUndefined();
    expect(h.headers['cookie']).toBeUndefined();
    expect(h.headers['sec-fetch-mode']).toBeUndefined();
  }
  expect(w.browserToSender).toEqual([]);
  expect(w.dialogs).toEqual([]);
  expect(w.cspConsole).toEqual([]);
  expect(w.cspReports).toEqual([]);
});

test('the render carries its CSP to any client, and stays inert when visited directly', async ({ page, request }) => {
  const t = tag();
  const [m] = await seedMail(api, [{ subject: `HTML ancestors ${t}`, text: 'plain', html: '<p id="x">framed only</p>' }]);
  if (m === undefined) throw new Error('seed returned nothing');
  const ticket = (await (await api.get(`/api/messages/${m.id}/render`)).json()) as { url: string };
  const res = await request.get(ticket.url);
  expect(res.status()).toBe(200);
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'none'");
  expect(csp).not.toContain('script-src');
  expect(csp).toMatch(/frame-ancestors [^;]+/);
  expect(res.headers()['set-cookie']).toBeUndefined();

  // Visited directly, the CSP sandbox still applies: no script, opaque origin.
  const w = watch(page);
  await page.goto(ticket.url);
  await expect(page.locator('#x')).toHaveText('framed only');
  expect(w.dialogs).toEqual([]);
});
