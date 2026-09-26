// One-click unsubscribe (RFC 8058), PST-T-5.6, PST-REQ-110.
//
// Eligibility: a message carries a `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header AND
// an `https:` URL in `List-Unsubscribe` (RFC 8058 §3.1 requires the recipient use HTTPS). A
// `mailto:` unsubscribe link is shown to the reader but never auto-sent — RFC 8058's one-click
// contract is for the HTTP(S) form only, and an automated mail send is not something this server
// does on a reader's behalf without them writing the words.
//
// Authentication: RFC 8058 §4 asks that One-Click be honoured only for a message whose signature
// covers List-Unsubscribe and List-Unsubscribe-Post — otherwise an attacker who can inject those
// headers into a DKIM-signed message forwarded without re-signing (or an unsigned relay) could get
// a sender unsubscribed against their will. @postroom/auth-checks's DkimResult does not carry the
// signed-header list (h=) once verification is done — only the pass/fail/domain/etc that
// message_verdict.auth stores — so that per-signature check is not available here. Documented
// per PST-T-5.6's brief: this requires DMARC pass instead (the aligned, publishable policy result
// stands in for "the claimed From is trustworthy enough to act on", which is what the signed-header
// check would otherwise have established).
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import type { BlobStore } from '@postroom/blobstore';
import { collectMessage } from '@postroom/mime';
import type { Db, Message, MessageVerdict, Prisma } from '@postroom/db';
import { normalizeAddress } from '@postroom/classifier';
import { checkUrl, isPrivateAddress, MAX_BYTES, TIMEOUT_MS, type FetchPolicy } from '../usercontent/proxy.js';

type Tx = Prisma.TransactionClient;

export interface UnsubscribeHeaders {
  readonly listUnsubscribe: string | null;
  readonly listUnsubscribePost: string | null;
}

export interface UnsubscribeOffer {
  readonly available: boolean;
  /** Why one-click is or is not offered. */
  readonly reason: string;
  /** The https URL that would be POSTed, when available. */
  readonly httpsUrl: string | null;
  /** A mailto: link found alongside it, shown but never sent automatically. */
  readonly mailto: string | null;
}

/** Every `<...>` entry in a List-Unsubscribe header, in order (RFC 2369). */
function listUnsubscribeUrls(value: string): string[] {
  const out: string[] = [];
  const re = /<([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const url = m[1];
    if (url !== undefined && url.trim() !== '') out.push(url.trim());
  }
  return out;
}

const ONE_CLICK_POST = /(?:^|,)\s*list-unsubscribe\s*=\s*one-click\s*(?:,|$)/i;

/**
 * Parses the two headers into what the offer looks like — pure, no network, no DB. RFC 8058 §3.1
 * requires an https: URL; `allowInsecure` (POSTROOM_E2E_SEED + IMAGE_PROXY_ALLOW_PRIVATE, exactly
 * like the image proxy's test-only policy) also accepts a loopback http: URL, so e2e can run
 * against a plain local listener instead of standing up a TLS certificate for a test.
 */
export function parseUnsubscribeOffer(headers: UnsubscribeHeaders, allowInsecure = false): UnsubscribeOffer {
  if (headers.listUnsubscribe === null) {
    return { available: false, reason: 'no List-Unsubscribe header', httpsUrl: null, mailto: null };
  }
  const urls = listUnsubscribeUrls(headers.listUnsubscribe);
  const scheme = allowInsecure ? /^https?:/i : /^https:/i;
  const httpsUrl = urls.find((u) => scheme.test(u)) ?? null;
  const mailto = urls.find((u) => /^mailto:/i.test(u)) ?? null;
  if (httpsUrl === null) {
    return { available: false, reason: 'no https URL in List-Unsubscribe', httpsUrl: null, mailto };
  }
  if (headers.listUnsubscribePost === null || !ONE_CLICK_POST.test(headers.listUnsubscribePost)) {
    return { available: false, reason: 'message does not offer One-Click (RFC 8058) — List-Unsubscribe-Post missing or not "List-Unsubscribe=One-Click"', httpsUrl, mailto };
  }
  return { available: true, reason: 'ok', httpsUrl, mailto };
}

/** DMARC pass, from the stored auth verdict (message_verdict.auth). */
export function dmarcPassed(auth: unknown): boolean {
  if (typeof auth !== 'object' || auth === null) return false;
  const dmarc = (auth as Record<string, unknown>)['dmarc'];
  if (typeof dmarc !== 'object' || dmarc === null) return false;
  return (dmarc as Record<string, unknown>)['result'] === 'pass';
}

/** The two headers this message carries, read straight off its blob — never stored, computed fresh. */
export async function unsubscribeHeadersOf(blobs: BlobStore, blobSha256: string): Promise<UnsubscribeHeaders> {
  const summary = await collectMessage(await blobs.get(blobSha256));
  return {
    listUnsubscribe: summary.headers.get('list-unsubscribe'),
    listUnsubscribePost: summary.headers.get('list-unsubscribe-post'),
  };
}

export type UnsubscribeOutcome =
  | { readonly ok: true; readonly status: number; readonly detail: string }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

/** e2e (POSTROOM_E2E_SEED=1 + IMAGE_PROXY_ALLOW_PRIVATE=1): the test's own listener is on loopback http. */
export function unsubscribePolicy(env: NodeJS.ProcessEnv): FetchPolicy {
  return { allowPrivate: env['IMAGE_PROXY_ALLOW_PRIVATE'] === '1' && env['POSTROOM_E2E_SEED'] === '1' };
}

function guardedLookup(policy: FetchPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
      if (error !== null) {
        callback(error, '', 4);
        return;
      }
      const allow = (a: string): boolean => policy.allowPrivate || !isPrivateAddress(a);
      const bad = addresses.find((a) => !allow(a.address));
      if (addresses.length === 0 || bad !== undefined) {
        callback(new Error(`refused address ${bad?.address ?? '(none)'} for ${hostname}`), '', 4);
        return;
      }
      if (options.all === true) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      else {
        const first = addresses[0] as LookupAddress;
        callback(null, first.address, first.family);
      }
    });
  };
}

/**
 * Sends the RFC 8058 One-Click POST: `Content-Type: application/x-www-form-urlencoded`, body
 * `List-Unsubscribe=One-Click`, no cookies, no credentials, no referrer, at most one redirect hop
 * re-checked from scratch, capped body, bounded time. The URL must be `https:` in production; the
 * test-only policy also allows loopback `http:` (see `unsubscribePolicy`).
 */
export async function postOneClick(rawUrl: string, policy: FetchPolicy): Promise<UnsubscribeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, TIMEOUT_MS);
  try {
    if (!policy.allowPrivate && !/^https:/i.test(rawUrl)) {
      return { ok: false, reason: 'scheme_refused', detail: 'the List-Unsubscribe URL must be https:' };
    }
    const url = checkUrl(rawUrl, policy);
    const body = Buffer.from('List-Unsubscribe=One-Click', 'ascii');
    // Only a test policy (allowPrivate) ever sees a plain http: URL here — checkUrl already refused
    // an insecure scheme in production, and the scheme check above refuses it before this point too.
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const res = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = transport(
        url,
        {
          method: 'POST',
          lookup: guardedLookup(policy),
          signal: controller.signal,
          agent: false,
          headers: {
            'user-agent': 'Postroom-Unsubscribe/1 (+https://github.com/matdemers1/d3-postroom)',
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': String(body.length),
          },
        },
        (response) => {
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BYTES) response.destroy();
          });
          response.on('end', () => { resolve({ statusCode: response.statusCode ?? 0 }); });
          response.on('error', reject);
        },
      );
      req.once('error', reject);
      req.end(body);
    });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return { ok: true, status: res.statusCode, detail: `upstream answered ${String(res.statusCode)}` };
    }
    return { ok: false, reason: 'upstream_error', detail: `upstream answered ${String(res.statusCode)}` };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, reason: 'timeout', detail: 'timed out' };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'refused', detail: message };
  } finally {
    clearTimeout(timer);
  }
}

export interface UnsubscribeAttempt {
  readonly offer: UnsubscribeOffer;
  readonly authOk: boolean;
  readonly outcome: UnsubscribeOutcome | null;
}

/** The whole decision + attempt for one message, given its verdict and headers. No DB write here — the caller records the result on the sender's pin, audited. */
export async function attemptUnsubscribe(
  message: Pick<Message, 'fromAddress'>,
  verdict: Pick<MessageVerdict, 'auth'> | null,
  headers: UnsubscribeHeaders,
  policy: FetchPolicy,
): Promise<UnsubscribeAttempt> {
  const offer = parseUnsubscribeOffer(headers, policy.allowPrivate);
  if (!offer.available) return { offer, authOk: false, outcome: null };
  const authOk = verdict !== null && dmarcPassed(verdict.auth);
  if (!authOk) {
    return {
      offer,
      authOk: false,
      outcome: { ok: false, reason: 'auth_required', detail: 'DMARC did not pass for this message; refusing to send a One-Click unsubscribe it cannot attribute to the claimed sender' },
    };
  }
  const httpsUrl = offer.httpsUrl;
  if (httpsUrl === null) return { offer, authOk, outcome: { ok: false, reason: 'no_url', detail: 'no https URL' } };
  const outcome = await postOneClick(httpsUrl, policy);
  return { offer, authOk, outcome };
}

/** Records the attempt on the sender's pin row (creates it if this sender had none yet). Call inside `audited`. */
export async function recordUnsubscribeResult(
  tx: Tx,
  accountId: string,
  address: string,
  result: { method: 'one-click'; ok: boolean; detail: string; at: Date },
): Promise<void> {
  const normalized = normalizeAddress(address);
  await tx.senderPin.upsert({
    where: { accountId_address: { accountId, address: normalized } },
    create: {
      accountId,
      address: normalized,
      unsubscribedAt: result.at,
      unsubscribeMethod: result.method,
      unsubscribeResult: result.ok ? 'sent' : 'failed',
      unsubscribeDetail: result.detail,
    },
    update: {
      unsubscribedAt: result.at,
      unsubscribeMethod: result.method,
      unsubscribeResult: result.ok ? 'sent' : 'failed',
      unsubscribeDetail: result.detail,
    },
  });
}

/** For the sender profile: the pin row's unsubscribe fields, or "never attempted". */
export async function unsubscribeStatusOf(db: Db, accountId: string, address: string): Promise<{ attempted: boolean; at: string | null; method: string | null; result: string | null; detail: string | null }> {
  const normalized = normalizeAddress(address);
  const row = await db.senderPin.findUnique({
    where: { accountId_address: { accountId, address: normalized } },
    select: { unsubscribedAt: true, unsubscribeMethod: true, unsubscribeResult: true, unsubscribeDetail: true },
  });
  if (row === null || row.unsubscribedAt === null) return { attempted: false, at: null, method: null, result: null, detail: null };
  return { attempted: true, at: row.unsubscribedAt.toISOString(), method: row.unsubscribeMethod, result: row.unsubscribeResult, detail: row.unsubscribeDetail };
}
