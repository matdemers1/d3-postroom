// ARC validation (RFC 8617) and the DMARC override (PST-REQ-057).
//
// All fixtures are self-made with the test-only signer in fixtures/arc/signer.ts; none is a
// published vector. The main one is shaped like a Google Groups delivery:
//   1. alice@author.example (DMARC p=reject) sends, DKIM-signed by author.example.
//   2. Google Groups (team@googlegroups.com) receives it — mx.google.com sees dkim/spf/dmarc pass —
//      rewrites the Subject, appends a footer, adds List-Id and its own DKIM signature, and adds
//      ARC set i=1 sealed by google.com.
//   3. A Gmail forwarding hop adds ARC set i=2, also sealed by google.com; by then the author's
//      DKIM no longer verifies, so its AAR records dmarc=fail.
//   4. Postroom receives it: arc=pass, the author's DKIM fails, DMARC fails with p=reject — and a
//      chain of custody of trusted google.com seals, whose i=1 recorded dmarc=pass, overrides it.

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createDkimVerifier,
  dmarcFromAuthResults,
  dmarcWithArcOverride,
  dnsRecordFor,
  evaluateDmarc,
  verifyArc,
  type ArcResult,
  type DkimResult,
  type DmarcResult,
} from '../../src/index.js';
import { fakeDns, forgeSignature } from './fixtures/dkim/forge.js';
import { arcSeal, dropFields, editField } from './fixtures/arc/signer.js';

const NOW = new Date('2026-09-25T12:00:00Z');

let googleKey: KeyObject;
let evilKey: KeyObject;
let authorKey: KeyObject;
let groupsKey: KeyObject;
let dns: ReturnType<typeof fakeDns>;

const AUTHOR_MESSAGE =
  'From: Alice <alice@author.example>\r\n' +
  'To: team@googlegroups.com\r\n' +
  'Subject: Lunch on Friday\r\n' +
  'Date: Fri, 25 Sep 2026 11:00:00 +0000\r\n' +
  'Message-ID: <lunch-1@author.example>\r\n' +
  'MIME-Version: 1.0\r\n' +
  'Content-Type: text/plain; charset=utf-8\r\n' +
  '\r\n' +
  'Shall we try the new place on Friday?\r\n' +
  '\r\n' +
  'Alice\r\n';

const GROUPS_AAR =
  'mx.google.com;\r\n       dkim=pass header.i=@author.example header.s=s2026 header.b=abcdEFGH;\r\n' +
  '       spf=pass (google.com: domain of alice@author.example designates 192.0.2.10 as permitted sender) smtp.mailfrom=alice@author.example;\r\n' +
  '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=author.example';

const FORWARD_AAR =
  'mx.google.com;\r\n       arc=pass (i=1);\r\n       dkim=fail header.i=@author.example;\r\n' +
  '       dkim=pass header.i=@googlegroups.com header.s=20230601;\r\n' +
  '       spf=pass smtp.mailfrom=team+bncBC@googlegroups.com;\r\n' +
  '       dmarc=fail (p=REJECT sp=REJECT dis=REJECT) header.from=author.example';

/** Step 1: the author's signed message. */
function authorSigned(): string {
  const sig = forgeSignature(AUTHOR_MESSAGE, {
    key: authorKey,
    algorithm: 'ed25519-sha256',
    domain: 'author.example',
    selector: 's2026',
    headers: ['from', 'to', 'subject', 'date', 'message-id'],
  });
  return sig + AUTHOR_MESSAGE;
}

/** Step 2: the Google Groups hop — modify, re-sign as googlegroups.com, seal i=1. */
function throughGroups(message: string): string {
  let m = message
    .replace('Subject: Lunch on Friday', 'Subject: [team] Lunch on Friday')
    .replace('\r\n\r\n', '\r\nList-Id: <team.googlegroups.com>\r\n\r\n');
  m += '\r\n-- \r\nYou received this message because you are subscribed to the Google Groups "team" group.\r\n';
  const groupsSig = forgeSignature(m, {
    key: groupsKey,
    algorithm: 'ed25519-sha256',
    domain: 'googlegroups.com',
    selector: '20230601',
    headers: ['from', 'to', 'subject', 'date', 'message-id', 'list-id'],
  });
  m = groupsSig + m;
  return arcSeal(m, { key: googleKey, domain: 'google.com', selector: 'arc-20240605', authservId: 'mx.google.com', results: GROUPS_AAR });
}

/** Step 3: a forwarding hop that seals i=2 without changing the message. */
function forwardedBy(message: string, key: KeyObject, domain: string, results = FORWARD_AAR): string {
  return arcSeal(`Received: by 2002:a05:6a10:1234 with SMTP id x; Fri, 25 Sep 2026 11:00:02 -0700\r\n${message}`, {
    key,
    domain,
    selector: 'arc-20240605',
    authservId: 'mx.google.com',
    results,
  });
}

function chain(): string {
  return forwardedBy(throughGroups(authorSigned()), googleKey, 'google.com');
}

function verify(message: string, d = dns): Promise<ArcResult> {
  return verifyArc(Buffer.from(message, 'latin1'), { dns: d });
}

async function dkimOf(message: string): Promise<DkimResult[]> {
  return createDkimVerifier({ dns, now: NOW }).verifyStream(Buffer.from(message, 'latin1'));
}

beforeAll(() => {
  googleKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  evilKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  authorKey = generateKeyPairSync('ed25519').privateKey;
  groupsKey = generateKeyPairSync('ed25519').privateKey;
  dns = fakeDns({
    'arc-20240605._domainkey.google.com': dnsRecordFor('rsa-sha256', googleKey),
    'arc-20240605._domainkey.evil.example': dnsRecordFor('rsa-sha256', evilKey),
    's2026._domainkey.author.example': dnsRecordFor('ed25519-sha256', authorKey),
    '20230601._domainkey.googlegroups.com': dnsRecordFor('ed25519-sha256', groupsKey),
    '_dmarc.author.example': 'v=DMARC1; p=reject; rua=mailto:dmarc@author.example',
  });
});

describe('ARC: a Google-Groups-shaped chain', () => {
  it('the author signature verifies before the list touches it', async () => {
    const rs = await dkimOf(authorSigned());
    expect(rs.map((r) => r.result)).toEqual(['pass']);
  });

  it('validates: arc=pass with two google.com seals', async () => {
    const r = await verify(chain());
    expect(r).toMatchObject({ result: 'pass', instances: 2, oldestPass: 1, sealerDomains: ['google.com', 'google.com'], temporary: false });
    expect(r.sets.map((s) => [s.instance, s.cv, s.ams, s.seal, s.authservId])).toEqual([
      [1, 'none', 'pass', 'pass', 'mx.google.com'],
      [2, 'pass', 'pass', 'pass', 'mx.google.com'],
    ]);
    expect(r.authResults).toBe('arc=pass (i=2 oldest-pass=1 sealed by google.com, google.com)');
    expect(r.sets[0]?.authResults).toMatch(/dmarc=pass .* header\.from=author\.example$/);
  });

  it('a single Groups set validates on its own (i=1)', async () => {
    const r = await verify(throughGroups(authorSigned()));
    expect(r).toMatchObject({ result: 'pass', instances: 1, oldestPass: 1 });
  });

  it('works on a streamed message', async () => {
    const r = await verifyArc(Readable.from([Buffer.from(chain(), 'latin1')]), { dns });
    expect(r.result).toBe('pass');
  });

  it('end to end: original DKIM fails, DMARC fails, trusted ARC overrides with a reason', async () => {
    const message = chain();
    const dkim = await dkimOf(message);
    expect(dkim.map((r) => [r.domain, r.result])).toEqual([
      ['googlegroups.com', 'pass'],
      ['author.example', 'fail'],
    ]);

    const dmarc: DmarcResult = await evaluateDmarc({
      dns,
      from: ['Alice <alice@author.example>'],
      spf: { result: 'pass', domain: 'googlegroups.com' },
      dkim,
    });
    expect(dmarc).toMatchObject({ result: 'fail', policy: 'reject', disposition: 'reject' });

    const arc = await verify(message);
    expect(arc.result).toBe('pass');

    const untrusted = dmarcWithArcOverride(dmarc, arc, []);
    expect(untrusted).toMatchObject({ disposition: 'reject', overridden: false });
    expect(untrusted.reason).toBe('DMARC reject stands: ARC set i=2 is sealed by google.com, which is not trusted');

    const decision = dmarcWithArcOverride(dmarc, arc, ['google.com']);
    expect(decision).toEqual({
      disposition: 'none',
      overridden: true,
      sealer: { instance: 1, domain: 'google.com' },
      reason: 'DMARC fail overridden by ARC pass sealed by google.com (trusted): ARC set i=1 recorded dmarc=pass header.from=author.example',
    });
  });

  it('an untrusted most-recent sealer breaks the chain of custody', async () => {
    const message = forwardedBy(throughGroups(authorSigned()), evilKey, 'evil.example');
    const arc = await verify(message);
    expect(arc).toMatchObject({ result: 'pass', sealerDomains: ['google.com', 'evil.example'] });
    const dmarc = await evaluateDmarc({ dns, from: ['alice@author.example'], dkim: await dkimOf(message) });
    const decision = dmarcWithArcOverride(dmarc, arc, ['google.com']);
    expect(decision.overridden).toBe(false);
    expect(decision.disposition).toBe('reject');
    expect(decision.reason).toMatch(/i=2 is sealed by evil\.example, which is not trusted/);
  });

  it('a trusted chain whose AARs never recorded dmarc=pass does not override', async () => {
    const noPass = 'mx.google.com; dkim=none; spf=softfail smtp.mailfrom=alice@author.example; dmarc=fail header.from=author.example';
    const once = arcSeal(authorSigned().replace('Subject: Lunch', 'Subject: [x] Lunch'), {
      key: googleKey,
      domain: 'google.com',
      selector: 'arc-20240605',
      authservId: 'mx.google.com',
      results: noPass,
    });
    const arc = await verify(once);
    expect(arc.result).toBe('pass');
    const dmarc = await evaluateDmarc({ dns, from: ['alice@author.example'], dkim: await dkimOf(once) });
    const decision = dmarcWithArcOverride(dmarc, arc, ['google.com']);
    expect(decision.overridden).toBe(false);
    expect(decision.reason).toMatch(/no trusted ARC set recorded dmarc=pass for author\.example \[i=1 \(google\.com: dmarc=fail\)\]/);
    // Unless the operator opts out of requiring the AAR's evidence.
    const lax = dmarcWithArcOverride(dmarc, arc, { trustedSealers: ['google.com'], requireDmarcPassInAar: false });
    expect(lax).toMatchObject({ overridden: true, disposition: 'none' });
  });

  it('a dmarc=pass recorded for a different From domain does not count', async () => {
    const other = GROUPS_AAR.replace('header.from=author.example', 'header.from=other.example');
    const m = forwardedBy(
      arcSeal(authorSigned().replace('Subject: Lunch', 'Subject: [x] Lunch'), {
        key: googleKey,
        domain: 'google.com',
        selector: 'arc-20240605',
        authservId: 'mx.google.com',
        results: other,
      }),
      googleKey,
      'google.com',
    );
    const dmarc = await evaluateDmarc({ dns, from: ['alice@author.example'], dkim: await dkimOf(m) });
    const decision = dmarcWithArcOverride(dmarc, await verify(m), ['google.com']);
    expect(decision.overridden).toBe(false);
    expect(decision.reason).toMatch(/dmarc=pass for other\.example/);
  });

  it('no override is needed when DMARC passed or the policy is none', async () => {
    const arc = await verify(chain());
    const pass = await evaluateDmarc({ dns, from: ['alice@author.example'], dkim: await dkimOf(authorSigned()) });
    expect(pass.result).toBe('pass');
    expect(dmarcWithArcOverride(pass, arc, ['google.com'])).toMatchObject({ overridden: false, disposition: 'none' });
  });

  it('an ARC fail never overrides', async () => {
    const broken = chain().replace('Shall we try', 'Shall we skip');
    const arc = await verify(broken);
    expect(arc.result).toBe('fail');
    const dmarc = await evaluateDmarc({ dns, from: ['alice@author.example'], dkim: await dkimOf(broken) });
    expect(dmarcWithArcOverride(dmarc, arc, ['google.com'])).toMatchObject({
      overridden: false,
      disposition: 'reject',
      reason: 'DMARC reject stands: arc=fail',
    });
  });
});

describe('ARC: tampering and structure', () => {
  it('no ARC header fields → none', async () => {
    const r = await verify(authorSigned());
    expect(r).toMatchObject({ result: 'none', instances: 0, reasons: ['no ARC header fields'] });
    expect(r.authResults).toBe('arc=none');
  });

  it('the body changed after the last hop → the latest AMS fails', async () => {
    const r = await verify(chain().replace('Shall we try', 'Shall we skip'));
    expect(r.result).toBe('fail');
    expect(r.reasons[0]).toMatch(/^ARC-Message-Signature i=2: body hash mismatch/);
    expect(r.sets[1]?.ams).toBe('fail');
  });

  it('a hop that modifies before sealing: still pass, oldest-pass moves up, the old AMS failure is only noted', async () => {
    const groups = throughGroups(authorSigned());
    const modified = `${groups}\r\nFooter added by the forwarder.\r\n`;
    const r = await verify(forwardedBy(modified, googleKey, 'google.com'));
    expect(r).toMatchObject({ result: 'pass', oldestPass: 2 });
    expect(r.sets[0]?.ams).toBe('fail');
    expect(r.reasons[1]).toMatch(/ARC-Message-Signature i=1: body hash mismatch .*not a chain failure/);
  });

  it('a forged AAR (what a hop "saw") breaks the seals', async () => {
    const forged = editField(
      chain(),
      (raw) => raw.startsWith('ARC-Authentication-Results: i=1'),
      (raw) => raw.replace('dkim=pass header.i=@author.example', 'dkim=pass header.i=@paypal.example'),
    );
    const r = await verify(forged);
    expect(r.result).toBe('fail');
    expect(r.reasons[0]).toBe('ARC-Seal i=2: signature did not verify');
  });

  it('a broken ARC-Seal signature → fail', async () => {
    const one = throughGroups(authorSigned());
    const broken = editField(
      one,
      (raw) => raw.startsWith('ARC-Seal: i=1'),
      (raw) => raw.replace(/b=([A-Za-z0-9+/]{8})/, (_m, b: string) => `b=${b.split('').reverse().join('')}`),
    );
    const r = await verify(broken);
    expect(r.result).toBe('fail');
    expect(r.reasons[0]).toBe('ARC-Seal i=1: signature did not verify');
    expect(r.sets[0]?.seal).toBe('fail');
  });

  it('a missing ARC set instance → fail', async () => {
    const gap = dropFields(chain(), (_n, raw) => /^ARC-[A-Za-z-]+: i=1;/.test(raw));
    const r = await verify(gap);
    expect(r).toMatchObject({ result: 'fail', instances: 2 });
    expect(r.reasons[0]).toBe('ARC set i=1 is missing (instances must run 1..2 without gaps)');
  });

  it('an incomplete set → fail', async () => {
    const r = await verify(dropFields(chain(), (_n, raw) => raw.startsWith('ARC-Message-Signature: i=1;')));
    expect(r.result).toBe('fail');
    expect(r.reasons[0]).toBe('ARC set i=1 is incomplete: no ARC-Message-Signature');
  });

  it('a duplicated instance → fail', async () => {
    const m = chain();
    const seal1 = m.split('\r\n').find((l) => l.startsWith('ARC-Seal: i=1')) ?? '';
    const r = await verify(`${seal1}\r\n\tb=AAAA\r\n${m}`);
    expect(r.result).toBe('fail');
    expect(r.reasons[0]).toBe('more than one ARC-Seal with i=1');
  });

  it('cv=fail from a later hop propagates: the chain fails', async () => {
    const broken = chain().replace('Shall we try', 'Shall we skip');
    const third = forwardedBy(broken, googleKey, 'google.com', 'mx.google.com; arc=fail (i=2 body hash mismatch)');
    // Re-seal with cv=fail, as a sealer that saw the broken chain must.
    const withFail = arcSeal(broken, {
      key: googleKey,
      domain: 'google.com',
      selector: 'arc-20240605',
      authservId: 'mx.google.com',
      results: 'arc=fail',
      cv: 'fail',
    });
    // A hop that seals cv=pass over a body changed before it is indistinguishable from a hop that
    // modified the message itself: the seals hold, and only oldest-pass shows the change.
    expect(await verify(third)).toMatchObject({ result: 'pass', oldestPass: 3 });
    const r = await verify(withFail);
    expect(r).toMatchObject({ result: 'fail', instances: 3 });
    expect(r.reasons[0]).toBe('the most recent ARC-Seal (i=3) records cv=fail: the chain was already broken');
  });

  it('cv= must be none at i=1 and pass after', async () => {
    const bad1 = arcSeal(authorSigned(), { key: googleKey, domain: 'google.com', selector: 'arc-20240605', authservId: 'x', results: 'none', cv: 'pass' });
    expect((await verify(bad1)).reasons[0]).toBe('ARC-Seal i=1 has cv=pass; expected cv=none');
    const one = throughGroups(authorSigned());
    const bad2 = arcSeal(one, { key: googleKey, domain: 'google.com', selector: 'arc-20240605', authservId: 'x', results: 'none', cv: 'none' });
    expect((await verify(bad2)).reasons[0]).toBe('ARC-Seal i=2 has cv=none; expected cv=pass');
  });

  it('an ARC-Seal carrying h= → fail', async () => {
    const m = arcSeal(authorSigned(), {
      key: googleKey,
      domain: 'google.com',
      selector: 'arc-20240605',
      authservId: 'x',
      results: 'none',
      sealTags: { h: 'from' },
    });
    expect((await verify(m)).reasons[0]).toMatch(/ARC-Seal i=1 carries h=/);
  });

  it('an instance above 50 → fail', async () => {
    const m = arcSeal(authorSigned(), { key: googleKey, domain: 'google.com', selector: 'arc-20240605', authservId: 'x', results: 'none', instance: 51 });
    expect((await verify(m)).reasons[0]).toBe('ARC-Seal has i=51, outside 1..50');
  });

  it('a DNS temporary failure on a key → fail, marked temporary', async () => {
    const flaky = fakeDns({ 'arc-20240605._domainkey.google.com': 'SERVFAIL' });
    const r = await verify(chain(), flaky);
    expect(r).toMatchObject({ result: 'fail', temporary: true });
    expect(r.reasons[0]).toMatch(/DNS temporary failure/);
  });

  it('a missing key record → fail', async () => {
    const r = await verify(chain(), fakeDns({}));
    expect(r).toMatchObject({ result: 'fail', temporary: false });
    expect(r.reasons[0]).toMatch(/key record not found/);
  });

  it('ed25519-sha256 seals validate too', async () => {
    const edKey = generateKeyPairSync('ed25519');
    const edDns = fakeDns({ 'ed._domainkey.lists.example': dnsRecordFor('ed25519-sha256', edKey.publicKey) });
    const m = arcSeal(authorSigned(), {
      key: edKey.privateKey,
      algorithm: 'ed25519-sha256',
      domain: 'lists.example',
      selector: 'ed',
      authservId: 'lists.example',
      results: 'dkim=pass',
    });
    expect((await verify(m, edDns)).result).toBe('pass');
  });
});

describe('dmarcFromAuthResults', () => {
  it('reads dmarc= and header.from, ignoring comments', () => {
    expect(dmarcFromAuthResults(GROUPS_AAR)).toEqual({ result: 'pass', headerFrom: 'author.example' });
    expect(dmarcFromAuthResults('x; spf=pass (dmarc=pass in a comment)')).toBeUndefined();
    expect(dmarcFromAuthResults('x; dmarc=fail')).toEqual({ result: 'fail' });
  });
});
