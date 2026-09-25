// ARC chain validation (RFC 8617 §5.2), recorded as a verdict signal (PST-REQ-057).
//
// An ARC set is three header fields sharing an instance i=: ARC-Authentication-Results (what the
// intermediary saw), ARC-Message-Signature (a DKIM-like signature over the message as it left the
// intermediary) and ARC-Seal (a signature over every ARC set up to and including its own).
//
// Validation, in the spec's order:
//  1. No ARC header fields → none.
//  2. The most recent ARC-Seal says cv=fail → fail.
//  3. Structure: instances 1..N contiguous, N ≤ 50, exactly one of each field per instance,
//     i=1 carries cv=none and every later seal cv=pass.
//  4. The most recent AMS must validate. Earlier AMSs are checked too, from N-1 downward until one
//     fails, to find the oldest instance whose AMS still validates ("oldest-pass"); their failure
//     is expected (intermediaries modify messages) and only noted.
//  5. Every ARC-Seal must validate, from N down to 1.
//  6. pass.
//
// The AMS reuses DKIM's canonicalization, header selection, body hashing and key records. The seal
// is hashed over the ARC sets in increasing instance order, each set as AAR, AMS, AS, with relaxed
// header canonicalization; the seal being checked has an empty b= and no trailing CRLF (§5.1.1).
// A DNS temporary failure makes the chain fail (arc= has no temperror); `temporary` says so.

import { BodyHasher, canonicalizeHeader, parseCanonicalization, type Canonicalization } from '../dkim/canon.js';
import { DkimError } from '../dkim/errors.js';
import { headerHashInput, verifyHeaderData } from '../dkim/header-hash.js';
import { keyTypeFor, type DkimAlgorithm } from '../dkim/keys.js';
import { splitMessage, type HeaderField, type MessageInput, type SplitOptions } from '../dkim/message.js';
import { parseTagList, splitColonList, stripWhitespace, withEmptyB } from '../dkim/tags.js';
import { fetchKey, type DkimDns, type KeyLookup } from '../dkim/verify.js';

export const ARC_MAX_INSTANCES = 50;

export type ArcResultCode = 'none' | 'pass' | 'fail';
export type ArcCv = 'none' | 'pass' | 'fail';
export type ArcCheck = 'pass' | 'fail' | 'unchecked';

export interface ArcSetResult {
  readonly instance: number;
  /** d= of the ARC-Seal: who sealed this set. */
  readonly sealDomain?: string;
  readonly sealSelector?: string;
  readonly cv?: ArcCv;
  /** d= of the ARC-Message-Signature. */
  readonly amsDomain?: string;
  /** The authserv-id of the ARC-Authentication-Results. */
  readonly authservId?: string;
  /** The ARC-Authentication-Results value after "i=N;" — what this intermediary saw. */
  readonly authResults?: string;
  readonly ams: ArcCheck;
  readonly seal: ArcCheck;
  readonly reasons: readonly string[];
}

export interface ArcResult {
  readonly result: ArcResultCode;
  /** N: the highest instance. 0 when there is no chain. */
  readonly instances: number;
  /** The oldest instance whose AMS still validates (N when only the latest does). */
  readonly oldestPass?: number;
  /** Seal d= per instance, i=1 first. */
  readonly sealerDomains: readonly string[];
  /** Per-set detail, i=1 first. Empty when the structure could not be read. */
  readonly sets: readonly ArcSetResult[];
  /** A DNS temporary failure contributed to a fail. */
  readonly temporary: boolean;
  /** Why. Never empty. */
  readonly reasons: readonly string[];
  /** e.g. `arc=pass (i=2 oldest-pass=1 sealed by google.com, google.com)`. */
  readonly authResults: string;
}

export interface ArcVerifyOptions extends SplitOptions {
  readonly dns: DkimDns;
  /** RSA keys shorter than this fail. Default 1024 (RFC 8301). */
  readonly minRsaBits?: number;
}

// ---- parsing ----

interface RawSet {
  aar?: HeaderField;
  ams?: HeaderField;
  seal?: HeaderField;
}

const ARC_KEYS = new Set(['arc-authentication-results', 'arc-message-signature', 'arc-seal']);

function fieldText(f: HeaderField): string {
  return f.raw.toString('latin1');
}

function fieldValue(f: HeaderField): string {
  const t = fieldText(f);
  return t.slice(t.indexOf(':') + 1);
}

/** The i= of an ARC field; undefined when missing or malformed. */
function instanceOf(f: HeaderField): number | undefined {
  let raw: string | undefined;
  if (f.key === 'arc-authentication-results') {
    raw = /^\s*i\s*=\s*([0-9]+)\s*;/.exec(fieldValue(f).replace(/\r\n/g, ''))?.[1];
  } else {
    try {
      raw = parseTagList(fieldValue(f)).get('i');
    } catch (err) {
      if (err instanceof DkimError) return undefined;
      throw err;
    }
  }
  if (raw === undefined || !/^[0-9]{1,3}$/.test(raw)) return undefined;
  return Number(raw);
}

interface SigTags {
  readonly raw: string;
  readonly algorithm: DkimAlgorithm;
  readonly domain: string;
  readonly selector: string;
  readonly signature: Buffer;
  readonly tags: Map<string, string>;
}

type SigParse = { readonly ok: true; readonly sig: SigTags } | { readonly ok: false; readonly reason: string; readonly domain?: string; readonly selector?: string };

function parseSig(f: HeaderField, what: string, required: readonly string[]): SigParse {
  const raw = fieldText(f);
  let tags: Map<string, string>;
  try {
    tags = parseTagList(fieldValue(f));
  } catch (err) {
    if (err instanceof DkimError) return { ok: false, reason: `${what} is malformed: ${err.message}` };
    throw err;
  }
  const d = tags.get('d')?.toLowerCase().replace(/\.$/, '');
  const s = tags.get('s');
  const id = { ...(d === undefined ? {} : { domain: d }), ...(s === undefined ? {} : { selector: s }) };
  for (const name of required) {
    const v = tags.get(name);
    if (v === undefined || stripWhitespace(v) === '') return { ok: false, reason: `${what} is missing ${name}=`, ...id };
  }
  const a = (tags.get('a') ?? '').toLowerCase();
  if (a !== 'rsa-sha256' && a !== 'ed25519-sha256') return { ok: false, reason: `${what} has unsupported a=${a}`, ...id };
  if (d === undefined || s === undefined) return { ok: false, reason: `${what} is missing d= or s=`, ...id };
  const b = stripWhitespace(tags.get('b') ?? '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b)) return { ok: false, reason: `${what} b= is not base64`, ...id };
  return { ok: true, sig: { raw, algorithm: a, domain: d, selector: s, signature: Buffer.from(b, 'base64'), tags } };
}

// ---- the seal's signed data ----

/** One ARC set's three fields as raw text (name included, no terminating CRLF). */
export interface ArcSetText {
  readonly aar: string;
  readonly ams: string;
  readonly seal: string;
}

/**
 * The data an ARC-Seal signs (RFC 8617 §5.1.1): the sets in increasing instance order, each as
 * AAR, AMS, AS, relaxed-canonicalized and CRLF-terminated — except the last AS (the seal being
 * made or checked), which must already have an empty b= and gets no CRLF. Shared by the verifier
 * and the test signer so both hash the same bytes.
 */
export function arcSealHashInput(sets: readonly ArcSetText[]): Buffer {
  const parts: string[] = [];
  sets.forEach((set, n) => {
    parts.push(canonicalizeHeader(set.aar, 'relaxed'), '\r\n');
    parts.push(canonicalizeHeader(set.ams, 'relaxed'), '\r\n');
    parts.push(canonicalizeHeader(set.seal, 'relaxed'));
    if (n < sets.length - 1) parts.push('\r\n');
  });
  return Buffer.from(parts.join(''), 'latin1');
}

// ---- verification ----

interface CheckOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly temporary?: boolean;
}

class KeyCache {
  private readonly lookups = new Map<string, Promise<KeyLookup>>();
  constructor(private readonly dns: DkimDns) {}
  get(selector: string, domain: string): Promise<KeyLookup> {
    const name = `${selector}._domainkey.${domain}`;
    let p = this.lookups.get(name);
    if (p === undefined) {
      p = fetchKey(this.dns, name);
      this.lookups.set(name, p);
    }
    return p;
  }
}

async function checkSignature(
  keys: KeyCache,
  sig: SigTags,
  data: Buffer,
  minRsaBits: number,
  what: string,
): Promise<CheckOutcome> {
  const lookup = await keys.get(sig.selector, sig.domain);
  if (lookup.kind !== 'key') {
    return { ok: false, reason: `${what}: ${lookup.reason}`, ...(lookup.kind === 'temperror' ? { temporary: true } : {}) };
  }
  const key = lookup.key;
  if (key.publicKey === undefined) return { ok: false, reason: `${what}: key revoked (empty p=)` };
  if (key.keyType !== keyTypeFor(sig.algorithm)) return { ok: false, reason: `${what}: key type ${key.keyType} does not match a=${sig.algorithm}` };
  if (key.keyType === 'rsa' && (key.bits ?? 0) < minRsaBits) {
    return { ok: false, reason: `${what}: RSA key is ${key.bits ?? 0} bits; at least ${minRsaBits} required` };
  }
  let ok: boolean;
  try {
    ok = verifyHeaderData(sig.algorithm, key.publicKey, data, sig.signature);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return { ok: false, reason: `${what}: signature did not verify (${err.message})` };
  }
  return ok ? { ok: true } : { ok: false, reason: `${what}: signature did not verify` };
}

interface AmsPlan {
  readonly sig: SigTags;
  readonly headerCanon: Canonicalization;
  readonly signedHeaders: readonly string[];
  readonly bodyHash: Buffer;
  readonly hasher: BodyHasher;
  readonly length: number | undefined;
}

function planAms(f: HeaderField, hashers: Map<string, BodyHasher>): { ok: true; plan: AmsPlan } | { ok: false; reason: string; domain?: string } {
  const parsed = parseSig(f, 'ARC-Message-Signature', ['i', 'a', 'b', 'bh', 'd', 'h', 's']);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, ...(parsed.domain === undefined ? {} : { domain: parsed.domain }) };
  const { sig } = parsed;
  const bad = (reason: string): { ok: false; reason: string; domain: string } => ({ ok: false, reason, domain: sig.domain });
  const c = parseCanonicalization(sig.tags.get('c'));
  if (c === undefined) return bad(`ARC-Message-Signature has unsupported c=${sig.tags.get('c') ?? ''}`);
  const signedHeaders = splitColonList(sig.tags.get('h') ?? '');
  if (signedHeaders.some((h) => h.toLowerCase() === 'arc-seal')) return bad('ARC-Message-Signature h= includes ARC-Seal (RFC 8617 §4.1.2)');
  const l = sig.tags.get('l');
  let length: number | undefined;
  if (l !== undefined) {
    if (!/^[0-9]{1,18}$/.test(l)) return bad('ARC-Message-Signature l= is not a decimal length');
    length = Number(l);
  }
  const bh = stripWhitespace(sig.tags.get('bh') ?? '');
  const bodyHash = Buffer.from(bh, 'base64');
  if (bodyHash.length !== 32) return bad('ARC-Message-Signature bh= is not a SHA-256 digest');
  const hk = `${c.body}:${length === undefined ? '' : String(length)}`;
  let hasher = hashers.get(hk);
  if (hasher === undefined) {
    hasher = new BodyHasher(c.body, length);
    hashers.set(hk, hasher);
  }
  return { ok: true, plan: { sig, headerCanon: c.header, signedHeaders, bodyHash, hasher, length } };
}

async function checkAms(
  plan: AmsPlan,
  fields: readonly HeaderField[],
  keys: KeyCache,
  minRsaBits: number,
  instance: number,
): Promise<CheckOutcome> {
  const what = `ARC-Message-Signature i=${instance}`;
  const digest = plan.hasher.digest();
  if (plan.length !== undefined && plan.length > plan.hasher.canonicalLength) {
    return { ok: false, reason: `${what}: l= exceeds the canonical body length` };
  }
  if (!digest.equals(plan.bodyHash)) return { ok: false, reason: `${what}: body hash mismatch (body changed since instance ${instance})` };
  const data = headerHashInput(fields, plan.signedHeaders, withEmptyB(plan.sig.raw), plan.headerCanon);
  return checkSignature(keys, plan.sig, data, minRsaBits, what);
}

type Unfinished = Omit<ArcResult, 'authResults'>;

function finish(r: Unfinished): ArcResult {
  return { ...r, authResults: authResultsArc(r) };
}

/** Authentication-Results text for an ARC result (RFC 8617 §10.1). */
export function authResultsArc(r: Unfinished): string {
  if (r.result === 'none') return 'arc=none';
  const bits = [`i=${r.instances}`];
  if (r.oldestPass !== undefined) bits.push(`oldest-pass=${r.oldestPass}`);
  if (r.result === 'pass') bits.push(`sealed by ${r.sealerDomains.join(', ')}`);
  else if (r.reasons[0] !== undefined) bits.push(r.reasons[0]);
  const comment = bits.join(' ').replace(/\(/g, '[').replace(/\)/g, ']').replace(/[\\\r\n]/g, ' ');
  return `arc=${r.result} (${comment})`;
}

/** Validate the ARC chain of `message`. The body is streamed once and never retained. Never throws on bad ARC data. */
export async function verifyArc(message: MessageInput, options: ArcVerifyOptions): Promise<ArcResult> {
  const split = await splitMessage(message, options);
  const fields = split.fields;
  const arcFields = fields.filter((f) => ARC_KEYS.has(f.key));
  const drain = async (): Promise<void> => {
    // Consume the body so a streamed source is fully read; nothing is hashed or kept.
    for await (const chunk of split.body) if (chunk.length < 0) break;
  };
  const fail = async (reasons: string[], extra: Partial<Unfinished> = {}): Promise<ArcResult> => {
    await drain();
    return finish({ result: 'fail', instances: 0, sealerDomains: [], sets: [], temporary: false, reasons, ...extra });
  };

  // 1. No chain.
  if (arcFields.length === 0) {
    await drain();
    return finish({ result: 'none', instances: 0, sealerDomains: [], sets: [], temporary: false, reasons: ['no ARC header fields'] });
  }

  // Collect sets by instance.
  const byInstance = new Map<number, RawSet>();
  for (const f of arcFields) {
    const i = instanceOf(f);
    const which = f.key === 'arc-authentication-results' ? 'aar' : f.key === 'arc-message-signature' ? 'ams' : 'seal';
    if (i === undefined) return fail([`${f.name} has a missing or malformed i= tag`]);
    if (i < 1 || i > ARC_MAX_INSTANCES) return fail([`${f.name} has i=${i}, outside 1..${ARC_MAX_INSTANCES}`]);
    const set = byInstance.get(i) ?? {};
    if (set[which] !== undefined) return fail([`more than one ${f.name} with i=${i}`]);
    set[which] = f;
    byInstance.set(i, set);
  }
  const n = Math.max(...byInstance.keys());
  const complete: { aar: HeaderField; ams: HeaderField; seal: HeaderField }[] = [];
  for (let i = 1; i <= n; i++) {
    const set = byInstance.get(i);
    if (set === undefined) return fail([`ARC set i=${i} is missing (instances must run 1..${n} without gaps)`], { instances: n });
    const missing = (['aar', 'ams', 'seal'] as const).filter((k) => set[k] === undefined);
    if (set.aar === undefined || set.ams === undefined || set.seal === undefined) {
      const names = { aar: 'ARC-Authentication-Results', ams: 'ARC-Message-Signature', seal: 'ARC-Seal' };
      return fail([`ARC set i=${i} is incomplete: no ${missing.map((k) => names[k]).join(', ')}`], { instances: n });
    }
    complete.push({ aar: set.aar, ams: set.ams, seal: set.seal });
  }

  // Parse seals (for cv and structure) and AMSs (body hashers must exist before the body streams).
  const hashers = new Map<string, BodyHasher>();
  const seals: SigParse[] = complete.map((s) => parseSig(s.seal, 'ARC-Seal', ['i', 'a', 'b', 'cv', 'd', 's']));
  const amsPlans = complete.map((s) => planAms(s.ams, hashers));
  for await (const chunk of split.body) for (const h of hashers.values()) h.update(chunk);

  const setInfo: {
    instance: number;
    sealDomain?: string;
    sealSelector?: string;
    cv?: ArcCv;
    amsDomain?: string;
    authservId?: string;
    authResults?: string;
    ams: ArcCheck;
    seal: ArcCheck;
    reasons: string[];
  }[] = complete.map((s, idx) => {
    const aarValue = fieldValue(s.aar).replace(/\r\n/g, '');
    const m = /^\s*i\s*=\s*[0-9]+\s*;\s*([^;\s]+)\s*;?(.*)$/s.exec(aarValue);
    const seal = seals[idx];
    const ams = amsPlans[idx];
    const cvRaw = seal?.ok === true ? seal.sig.tags.get('cv')?.toLowerCase() : undefined;
    const sealDomain = seal?.ok === true ? seal.sig.domain : seal?.domain;
    const sealSelector = seal?.ok === true ? seal.sig.selector : seal?.selector;
    const amsDomain = ams?.ok === true ? ams.plan.sig.domain : ams?.domain;
    return {
      instance: idx + 1,
      ...(sealDomain === undefined ? {} : { sealDomain }),
      ...(sealSelector === undefined ? {} : { sealSelector }),
      ...(cvRaw === 'none' || cvRaw === 'pass' || cvRaw === 'fail' ? { cv: cvRaw } : {}),
      ...(amsDomain === undefined ? {} : { amsDomain }),
      ...(m?.[1] === undefined ? {} : { authservId: m[1] }),
      ...(m?.[2] === undefined ? {} : { authResults: m[2].trim() }),
      ams: 'unchecked',
      seal: 'unchecked',
      reasons: [],
    };
  });
  const sealerDomains = setInfo.map((s) => s.sealDomain ?? '?');
  const snapshot = (): ArcSetResult[] => setInfo.map((s) => ({ ...s, reasons: [...s.reasons] }));
  const failWith = (reasons: string[], temporary = false, oldestPass?: number): ArcResult =>
    finish({
      result: 'fail',
      instances: n,
      ...(oldestPass === undefined ? {} : { oldestPass }),
      sealerDomains,
      sets: snapshot(),
      temporary,
      reasons,
    });

  // 2. The latest seal's cv.
  const latest = setInfo[n - 1];
  if (latest?.cv === 'fail') return failWith([`the most recent ARC-Seal (i=${n}) records cv=fail: the chain was already broken`]);

  // 3. Structure: every seal parses, carries no h=, and the right cv.
  for (const [idx, seal] of seals.entries()) {
    const i = idx + 1;
    const info = setInfo[idx];
    if (!seal.ok) {
      info?.reasons.push(seal.reason);
      return failWith([`ARC-Seal i=${i}: ${seal.reason}`]);
    }
    if (seal.sig.tags.has('h')) return failWith([`ARC-Seal i=${i} carries h=, which an ARC-Seal must not (RFC 8617 §4.1.3)`]);
    const want: ArcCv = i === 1 ? 'none' : 'pass';
    const cv = info?.cv;
    if (cv !== want) return failWith([`ARC-Seal i=${i} has cv=${cv ?? seal.sig.tags.get('cv') ?? ''}; expected cv=${want}`]);
  }

  const keys = new KeyCache(options.dns);
  const minRsaBits = options.minRsaBits ?? 1024;

  // 4. The latest AMS must validate; walk older ones for oldest-pass.
  const latestPlan = amsPlans[n - 1];
  if (latestPlan === undefined || !latestPlan.ok) {
    const reason = latestPlan?.ok === false ? latestPlan.reason : 'ARC-Message-Signature missing';
    return failWith([`ARC-Message-Signature i=${n}: ${reason}`]);
  }
  const latestCheck = await checkAms(latestPlan.plan, fields, keys, minRsaBits, n);
  if (latest !== undefined) {
    latest.ams = latestCheck.ok ? 'pass' : 'fail';
    if (latestCheck.reason !== undefined) latest.reasons.push(latestCheck.reason);
  }
  if (!latestCheck.ok) return failWith([latestCheck.reason ?? `ARC-Message-Signature i=${n} did not validate`], latestCheck.temporary === true);
  let oldestPass = n;
  const notes: string[] = [];
  for (let i = n - 1; i >= 1; i--) {
    const plan = amsPlans[i - 1];
    const info = setInfo[i - 1];
    const check: CheckOutcome =
      plan === undefined || !plan.ok
        ? { ok: false, reason: `ARC-Message-Signature i=${i}: ${plan?.ok === false ? plan.reason : 'missing'}` }
        : await checkAms(plan.plan, fields, keys, minRsaBits, i);
    if (info !== undefined) {
      info.ams = check.ok ? 'pass' : 'fail';
      if (check.reason !== undefined) info.reasons.push(check.reason);
    }
    if (!check.ok) {
      notes.push(`${check.reason ?? `ARC-Message-Signature i=${i} did not validate`} (expected when an intermediary modified the message; not a chain failure)`);
      break;
    }
    oldestPass = i;
  }

  // 5. Every seal, newest first.
  for (let i = n; i >= 1; i--) {
    const seal = seals[i - 1];
    const info = setInfo[i - 1];
    if (seal?.ok !== true) return failWith([`ARC-Seal i=${i} could not be read`], false, oldestPass); // unreachable: step 3
    const texts: ArcSetText[] = complete.slice(0, i).map((s, idx) => ({
      aar: fieldText(s.aar),
      ams: fieldText(s.ams),
      seal: idx === i - 1 ? withEmptyB(fieldText(s.seal)) : fieldText(s.seal),
    }));
    const check = await checkSignature(keys, seal.sig, arcSealHashInput(texts), minRsaBits, `ARC-Seal i=${i}`);
    if (info !== undefined) {
      info.seal = check.ok ? 'pass' : 'fail';
      if (check.reason !== undefined) info.reasons.push(check.reason);
    }
    if (!check.ok) return failWith([check.reason ?? `ARC-Seal i=${i} did not validate`, ...notes], check.temporary === true, oldestPass);
  }

  return finish({
    result: 'pass',
    instances: n,
    oldestPass,
    sealerDomains,
    sets: snapshot(),
    temporary: false,
    reasons: [`ARC chain of ${n} set${n === 1 ? '' : 's'} validated, sealed by ${sealerDomains.join(', ')}`, ...notes],
  });
}
