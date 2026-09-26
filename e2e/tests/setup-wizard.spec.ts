// PST-T-4.8's exit demo, as a suite (PST-REQ-098, PST-REQ-099): a fresh install walks the setup
// wizard — domain, DKIM keys, the live DNS check (a deliberately wrong SPF shows Fail, then Pass once
// fixed), mailbox — and ends with a test message and its delivery timeline.
//
// Delivering to a real external address needs the AWS edge (outbound :25 from home is blocked),
// which is not provisioned. So the "remote" is faked, in one of two ways:
//
//   Fake MX mode (E2E_FAKE_DNS_PORT and E2E_FAKE_MX_PORT set): this file runs a DNS server and an
//   SMTP server on 127.0.0.1. The api's DNS_RESOLVER and the delivery daemon's resolver point at the
//   DNS server, which publishes Postroom's zone (for the checker) and an MX for fake-remote.test (for
//   the delivery). The real delivery worker then resolves the MX through our hand-rolled resolver,
//   runs the SMTP session against the fake MX, and records the attempt — the timeline is real, and
//   the fake MX's copy is checked for the DKIM signature. (The worker must be told the MX port: an
//   unprivileged process cannot listen on 25.)
//
//   Stub mode (neither set — the docker e2e stack, whose daemons cannot reach this runner): the
//   test message is still sent through the real submission path, and the delivered attempt is
//   recorded by the e2e-only POST /api/admin/dev/fake-delivery, marked transport "e2e-stub".
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type Server } from 'node:net';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, freshCode, loadOperator, signInCookies, type Operator } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 240_000 });

const CSRF = { 'x-postroom-csrf': '1' };
const DNS_PORT = Number(process.env['E2E_FAKE_DNS_PORT'] ?? '0');
const MX_PORT = Number(process.env['E2E_FAKE_MX_PORT'] ?? '0');
const FAKE_MX = DNS_PORT > 0 && MX_PORT > 0;
const EDGE = process.env['E2E_EDGE_IP'] ?? '203.0.113.7';
const REMOTE = 'fake-remote.test';
const TO = `wizard-test@${REMOTE}`;

// --- A tiny authoritative-looking DNS server (UDP), enough for the checker and the MX client ----

type Rec = { type: 'A'; value: string } | { type: 'MX'; pref: number; host: string } | { type: 'TXT'; value: string } | { type: 'CNAME' | 'PTR'; value: string } | { type: 'SRV'; port: number; target: string };
const TYPE = { A: 1, CNAME: 5, PTR: 12, MX: 15, TXT: 16, SRV: 33 } as const;
const zone = new Map<string, Rec[]>();

function nameBytes(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.').filter((l) => l !== '');
  return Buffer.concat([...parts.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'latin1')])), Buffer.from([0])]);
}

function rdata(r: Rec): Buffer {
  switch (r.type) {
    case 'A':
      return Buffer.from(r.value.split('.').map(Number));
    case 'MX':
      return Buffer.concat([Buffer.from([r.pref >> 8, r.pref & 0xff]), nameBytes(r.host)]);
    case 'TXT': {
      const chunks: Buffer[] = [];
      const raw = Buffer.from(r.value, 'latin1');
      for (let i = 0; i < raw.length; i += 255) {
        const c = raw.subarray(i, i + 255);
        chunks.push(Buffer.from([c.length]), c);
      }
      return Buffer.concat(chunks);
    }
    case 'CNAME':
    case 'PTR':
      return nameBytes(r.value);
    case 'SRV':
      return Buffer.concat([Buffer.from([0, 0, 0, 1, r.port >> 8, r.port & 0xff]), nameBytes(r.target)]);
  }
}

function answer(query: Buffer): Buffer | null {
  if (query.length < 12) return null;
  let i = 12;
  const labels: string[] = [];
  for (;;) {
    const len = query[i];
    if (len === undefined) return null;
    if (len === 0) break;
    labels.push(query.subarray(i + 1, i + 1 + len).toString('latin1'));
    i += 1 + len;
  }
  const qEnd = i + 5;
  const qtype = query.readUInt16BE(i + 1);
  const name = labels.join('.').toLowerCase();
  const records = zone.get(name);
  const matches = (records ?? []).filter((r) => TYPE[r.type] === qtype);
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  const rd = (query[2] ?? 0) & 0x01;
  header[2] = 0x80 | rd;
  header[3] = 0x80 | (records === undefined ? 3 : 0);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(matches.length, 6);
  const answers = matches.map((r) => {
    const data = rdata(r);
    const rr = Buffer.alloc(12);
    rr.writeUInt16BE(0xc00c, 0);
    rr.writeUInt16BE(TYPE[r.type], 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(60, 6);
    rr.writeUInt16BE(data.length, 10);
    return Buffer.concat([rr, data]);
  });
  return Buffer.concat([header, query.subarray(12, qEnd), ...answers]);
}

// --- A plaintext SMTP server standing in for the remote MX ----------------------------------------

const received: { from: string; to: string[]; data: string }[] = [];

function fakeMx(): Server {
  return createServer((socket) => {
    let buffer = '';
    let inData = false;
    let from = '';
    let to: string[] = [];
    const say = (line: string): void => {
      socket.write(`${line}\r\n`);
    };
    say(`220 mx.${REMOTE} ESMTP fake`);
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          received.push({ from, to, data: buffer.slice(0, end + 2) });
          buffer = buffer.slice(end + 5);
          inData = false;
          say('250 2.0.0 OK queued by the fake MX');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') socket.write(`250-mx.${REMOTE}\r\n250-8BITMIME\r\n250 SIZE 104857600\r\n`);
        else if (verb === 'HELO') say(`250 mx.${REMOTE}`);
        else if (verb === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          say('250 2.1.0 OK');
        } else if (verb === 'RCPT') {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          say('250 2.1.5 OK');
        } else if (verb === 'DATA') {
          inData = true;
          say('354 go ahead');
        } else if (verb === 'RSET') say('250 2.0.0 OK');
        else if (verb === 'NOOP') say('250 2.0.0 OK');
        else if (verb === 'QUIT') {
          say('221 2.0.0 bye');
          socket.end();
          return;
        } else say('502 5.5.2 not here');
      }
    });
    socket.on('error', () => undefined);
  });
}

let dns: UdpSocket | null = null;
let mx: Server | null = null;
let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
let operator: Operator;

interface Wizard {
  step: string;
  completed: boolean;
  domain: string | null;
  suggestedDomain: string;
  dkim: { selector: string; dnsName: string; dnsRecord: string }[];
  test: { outboundId: string } | null;
}

const wizard = async (): Promise<Wizard> => (await (await api.get('/api/admin/setup-wizard')).json()) as Wizard;

/** Postroom's zone as it will be published, with SPF deliberately wrong (the wrong IP). */
function publishZone(domain: string, dkim: Wizard['dkim'], spfIp: string): void {
  const host = `mail.${domain}`;
  zone.set(domain, [{ type: 'TXT', value: `v=spf1 ip4:${spfIp} -all` }]);
  zone.set(host, [{ type: 'A', value: EDGE }]);
  zone.set(EDGE.split('.').reverse().join('.') + '.in-addr.arpa', [{ type: 'PTR', value: host }]);
  for (const k of dkim) zone.set(k.dnsName, [{ type: 'TXT', value: k.dnsRecord }]);
  zone.set(`_dmarc.${domain}`, [{ type: 'TXT', value: `v=DMARC1; p=none; rua=mailto:dmarc-reports@${domain}` }]);
  zone.set(`_smtp._tls.${domain}`, [{ type: 'TXT', value: `v=TLSRPTv1; rua=mailto:tls-reports@${domain}` }]);
  // The recipient's side: an MX on loopback.
  zone.set(REMOTE, [{ type: 'MX', pref: 10, host: `mx.${REMOTE}` }]);
  zone.set(`mx.${REMOTE}`, [{ type: 'A', value: '127.0.0.1' }]);
}

test.beforeAll(async ({ playwright }, testInfo) => {
  test.setTimeout(120_000);
  const baseURL = testInfo.project.use.baseURL;
  api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  operator = await ensureOperator(api);
  cookies = await signInCookies(api, operator);
  if (FAKE_MX) {
    const socket = createSocket('udp4');
    socket.on('message', (msg, rinfo) => {
      const reply = answer(msg);
      if (reply !== null) socket.send(reply, rinfo.port, rinfo.address);
    });
    await new Promise<void>((resolve) => socket.bind(DNS_PORT, '127.0.0.1', resolve));
    dns = socket;
    const server = fakeMx();
    await new Promise<void>((resolve) => server.listen(MX_PORT, '127.0.0.1', resolve));
    mx = server;
  }
});

test.afterAll(async () => {
  dns?.close();
  await new Promise<void>((resolve) => {
    if (mx === null) resolve();
    else mx.close(() => { resolve(); });
  });
  await api.dispose();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

/** Wait for `next`; answer the step-up prompt on the way if the server asked for one. */
async function thenMaybeStepUp(page: Page, next: ReturnType<Page['getByRole']>): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(next.or(dialog)).toBeVisible({ timeout: 30_000 });
  if (await dialog.isVisible()) {
    const current = loadOperator() ?? operator;
    await dialog.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(current));
    await dialog.getByRole('button', { name: 'Verify and continue' }).click();
    await expect(dialog).toBeHidden();
  }
  await expect(next).toBeVisible({ timeout: 30_000 });
}

/** No horizontal page scroll: the document is no wider than the viewport. */
const fitsWidth = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const g = globalThis as unknown as { document: { documentElement: { scrollWidth: number } }; innerWidth: number };
    return g.document.documentElement.scrollWidth <= g.innerWidth;
  });

const axe = async (page: Page, label: string): Promise<void> => {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
};

test('a fresh install walks the wizard to a delivered test message with its timeline', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the walk runs once, in the desktop project; the mobile project checks the finished screens at 390 px');
  const start = await wizard();
  test.skip(start.completed, 'the wizard already ran against this stack');

  await page.goto('/');
  // Admin nav carries the way in, with the steps left.
  await page.getByRole('link', { name: /^Setup/ }).click();
  await expect(page.getByRole('heading', { name: 'Set up mail', level: 1 })).toBeVisible();

  // 1. Domain.
  await page.getByRole('button', { name: '1. Domain' }).click();
  const domainInput = page.getByRole('textbox', { name: 'Domain' });
  await expect(domainInput).toHaveValue(start.suggestedDomain);
  await page.getByRole('button', { name: 'Save domain' }).click();
  await thenMaybeStepUp(page, page.getByRole('heading', { name: 'DKIM keys', level: 2 }));

  // 2. DKIM: generate (or confirm) the two keys, and show their TXT records with copy buttons.
  const generate = page.getByRole('button', { name: 'Generate DKIM keys' });
  if (await generate.isVisible()) {
    await generate.click();
    await thenMaybeStepUp(page, page.getByRole('button', { name: 'Continue to DNS' }));
  }
  const keys = (await wizard()).dkim;
  expect(keys.length).toBeGreaterThanOrEqual(2);
  for (const k of keys) await expect(page.getByRole('button', { name: `Copy ${k.selector} record value` })).toBeVisible();
  const domain = (await wizard()).domain ?? start.suggestedDomain;
  if (FAKE_MX) publishZone(domain, keys, '198.51.100.9');
  await page.getByRole('button', { name: 'Continue to DNS' }).click();
  await thenMaybeStepUp(page, page.getByRole('heading', { name: 'DNS records', level: 2 }));

  // 3. DNS: expected vs live, with copy buttons; the resolver is named.
  await expect(page.getByText('Answers come from Postroom’s own resolver')).toBeVisible();
  const spfRow = page.getByRole('row').filter({ hasText: /SPF\s*TXT/ });
  await expect(spfRow).toBeVisible({ timeout: 30_000 });
  await expect(spfRow.getByRole('button', { name: /^Copy expected SPF value/ }).or(spfRow.getByText('not provisioned')).first()).toBeVisible();
  if (FAKE_MX) {
    // PST-REQ-099's acceptance: a deliberately wrong SPF shows fail, with the reason.
    await expect(spfRow).toContainText('Fail');
    await expect(spfRow).toContainText('v=spf1 ip4:198.51.100.9 -all');
    await expect(spfRow).toContainText(`the edge is not authorised to send for ${domain}`);
    await axe(page, 'dns-step');
    // Fixed at the DNS host, then re-checked.
    publishZone(domain, keys, EDGE);
    await page.getByRole('button', { name: 'Re-check' }).click();
    await expect(spfRow).toContainText('Pass');
    await expect(page.getByRole('row').filter({ hasText: /DKIM\s*TXT/ }).first()).toContainText('Pass');
    await expect(page.getByRole('row').filter({ hasText: /MX\s*MX/ })).toContainText('Pending');
  }
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await thenMaybeStepUp(page, page.getByRole('heading', { name: 'Mailbox', level: 2 }));

  // 4. Mailbox: the operator's own address.
  await expect(page.getByRole('textbox', { name: 'Address' })).toHaveValue(operator.login);
  await page.getByRole('button', { name: 'Use this address' }).click();
  await thenMaybeStepUp(page, page.getByRole('heading', { name: 'Test message', level: 2 }));

  // 5. Test: to an external address, through the real submission path.
  await page.getByRole('textbox', { name: 'Send a test to' }).fill(TO);
  await page.getByRole('button', { name: 'Send test' }).click();
  await thenMaybeStepUp(page, page.getByRole('heading', { name: 'Delivery timeline', level: 3 }));
  const outboundId = (await wizard()).test?.outboundId;
  expect(outboundId).toBeDefined();

  const timeline = page.getByRole('list', { name: `Delivery timeline for ${TO}` });
  await expect(timeline).toContainText('Accepted and queued');
  if (FAKE_MX) {
    // The real delivery worker, through the fake DNS, to the fake MX.
    await expect(timeline).toContainText(`Delivered to ${TO}`, { timeout: 60_000 });
    await expect(timeline).toContainText(`Attempt via direct to mx.${REMOTE} (127.0.0.1): delivered`);
    await expect(timeline).toContainText('250 2.0.0 OK queued by the fake MX');
    const copy = received.find((m) => m.to.includes(TO));
    expect(copy, 'the fake MX received the test').toBeDefined();
    expect(copy?.data).toMatch(/^DKIM-Signature: v=1; a=ed25519-sha256;/m);
    expect(copy?.data).toMatch(/^Subject: Postroom test message/m);
  } else {
    const stub = await api.post('/api/admin/dev/fake-delivery', { headers: CSRF, data: { outboundId } });
    if (stub.status() === 404) throw new Error('no fake MX configured and no stub route: set E2E_FAKE_DNS_PORT/E2E_FAKE_MX_PORT or POSTROOM_E2E_SEED=1');
    // Each entry reads "<time> <title>", so match the title anywhere in the list, not at the start.
    await expect(timeline).toContainText(/Attempt via e2e-stub .*: delivered/, { timeout: 60_000 });
    await expect(timeline).toContainText(`Delivered to ${TO}`);
  }
  await axe(page, 'test-step');

  await page.getByRole('button', { name: 'Finish setup' }).click();
  await thenMaybeStepUp(page, page.getByText('Postroom is set up', { exact: true }));
  expect(await wizard()).toMatchObject({ step: 'done', completed: true });
  // The nav no longer counts steps left.
  await expect(page.getByRole('link', { name: /^Setup, \d+ steps? left/ })).toHaveCount(0);
});

test('the wizard and the DNS checker are axe-clean in light and dark, and fit 390 px', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((value) => {
      (globalThis as unknown as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem('postroom-theme', value);
    }, theme);
    await page.goto('/admin/dns');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('heading', { name: 'DNS records', level: 1 })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: /SPF\s*TXT/ })).toBeVisible({ timeout: 30_000 });
    await axe(page, `${theme} /admin/dns`);
    expect(await fitsWidth(page)).toBe(true);

    await page.goto('/admin/setup');
    await expect(page.getByRole('heading', { name: 'Set up mail', level: 1 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Setup steps' })).toBeVisible();
    await axe(page, `${theme} /admin/setup`);
    expect(await fitsWidth(page)).toBe(true);
  }
});
