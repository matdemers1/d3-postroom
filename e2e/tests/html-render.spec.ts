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

// PST-T-15.12: no white box. What the operator saw on 2026-09-30 in the dark theme: an Outlook reply
// drawn as a huge white slab, and every address in it shown as "[email protected]". A plain message
// (MsoNormal paragraphs, black/windowtext, no background) now renders on a transparent page in the
// app's own ink — the frame document's background is transparent — with its address text intact
// (the body sits inside Cloudflare's email_off markers). A designed message keeps its white page
// inside a radius-lg hairline.
test('an Outlook reply in the dark theme shows no white box, and its addresses are intact', async ({ page, context }) => {
  const t = tag();
  const html = [
    '<html><head><meta name=Generator content="Microsoft Word 15 (filtered medium)"><style><!--',
    'p.MsoNormal, li.MsoNormal, div.MsoNormal {margin:0in; font-size:11.0pt; font-family:"Calibri",sans-serif;}',
    'a:link, span.MsoHyperlink {mso-style-priority:99; color:#0563C1; text-decoration:underline;}',
    'span.EmailStyle17 {mso-style-type:personal-compose; font-family:"Calibri",sans-serif; color:windowtext;}',
    '--></style></head>',
    '<body lang=EN-US link="#0563C1" vlink="#954F72" style="word-wrap:break-word"><div class=WordSection1>',
    '<p class=MsoNormal id="first">test 2</p><p class=MsoNormal>V/R</p><p class=MsoNormal>Matthew Demers</p>',
    '<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in">',
    '<p class=MsoNormal><b><span style="color:black">From:</span></b><span id="from" style="color:black"> Matthew Demers &lt;matthew@d3cloud.io&gt;<br>',
    '<b>Sent:</b> Tuesday, September 29, 2026 9:12 PM<br><b>To:</b> someone@example.org<br><b>Subject:</b> test</span></p></div>',
    '</div></body></html>',
  ].join('\n');
  const text = 'test 2\r\nV/R\r\nMatthew Demers\r\n\r\nFrom: Matthew Demers <matthew@d3cloud.io>\r\nSent: Tuesday, September 29, 2026 9:12 PM\r\nTo: someone@example.org\r\nSubject: test\r\n';
  const designedHtml = '<table bgcolor="#f4f4f4" width="100%"><tr><td id="news">The weekly issue, from news@example.org</td></tr></table>';
  const [plain, designed] = await seedMail(api, [
    { subject: `RE: test ${t}`, from: 'Matthew Demers <matthew@d3cloud.io>', text, html },
    { subject: `Weekly issue ${t}`, from: 'News <news@example.org>', text: 'The weekly issue', html: designedHtml },
  ]);
  if (plain === undefined || designed === undefined) throw new Error('seed returned nothing');

  // The ticket says which look, and the served document carries the markers.
  const ticket = (await (await api.get(`/api/messages/${plain.id}/render?theme=dark`)).json()) as { url: string; designed: boolean };
  expect(ticket.designed).toBe(false);
  expect(new URL(ticket.url).searchParams.get('theme')).toBe('dark');
  const served = await (await api.get(ticket.url)).text();
  expect(served).toMatch(/<body><!--email_off-->[\s\S]*matthew@d3cloud\.io[\s\S]*<!--\/email_off--><\/body>/);

  await context.addInitScript(() => {
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem('postroom-theme', 'dark');
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await row(page, plain.subject).click();
  await expect(page.getByRole('heading', { name: plain.subject, level: 2 })).toBeVisible();

  const frameEl = page.getByTestId('message-html');
  await expect(frameEl).toBeVisible();
  expect(new URL((await frameEl.getAttribute('src')) ?? '').searchParams.get('theme')).toBe('dark');
  await expect(page.locator('.pr-frame')).toHaveAttribute('data-designed', 'false');
  await expect(frameEl).toHaveCSS('border-top-width', '0px');
  await expect(frameEl).toHaveCSS('border-top-left-radius', '0px');

  const frame = page.frameLocator('[data-testid="message-html"]');
  await expect(frame.locator('#first')).toHaveText('test 2');
  // No white box: the frame document paints nothing, and the text is the app's light ink.
  await expect(frame.locator('html')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(frame.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(frame.locator('#from')).toHaveCSS('color', 'rgb(240, 242, 247)');
  // The address is text, not an obfuscated placeholder.
  await expect(frame.locator('#from')).toContainText('Matthew Demers <matthew@d3cloud.io>');
  await expect(frame.locator('body')).not.toContainText('[email');

  // A designed message keeps its white page, inside a radius-lg hairline and no shadow.
  await row(page, designed.subject).click();
  await expect(page.getByRole('heading', { name: designed.subject, level: 2 })).toBeVisible();
  await expect(page.locator('.pr-frame')).toHaveAttribute('data-designed', 'true');
  await expect(page.getByTestId('message-html')).toHaveCSS('border-top-width', '1px');
  await expect(page.getByTestId('message-html')).toHaveCSS('border-top-left-radius', '14px');
  await expect(page.getByTestId('message-html')).toHaveCSS('box-shadow', 'none');
  const designedFrame = page.frameLocator('[data-testid="message-html"]');
  await expect(designedFrame.locator('#news')).toContainText('news@example.org');
  await expect(designedFrame.locator('html')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});
