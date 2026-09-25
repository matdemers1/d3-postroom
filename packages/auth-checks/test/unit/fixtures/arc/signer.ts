// A test-only ARC signer (RFC 8617 §5.1): adds one ARC set — ARC-Authentication-Results,
// ARC-Message-Signature, ARC-Seal — to a message, the way an intermediary would after checking it.
// Production Postroom does not seal (PST-T-2.5 needs validation only). It shares canonicalization,
// header-hash construction and the seal's hash input with the verifier, so a bug in those would
// show up as a failure of the independent tamper tests rather than hide.
//
// Every fixture built with it is self-made: none reproduces a published ARC test vector byte for
// byte (the ValiMail arc_test_suite vectors could not be recalled faithfully).

import { createHash, type KeyObject } from 'node:crypto';
import {
  arcSealHashInput,
  canonicalizeBody,
  headerHashInput,
  parseHeaderFields,
  signHeaderData,
  type ArcSetText,
  type DkimAlgorithm,
  type HeaderField,
} from '../../../../src/index.js';
import { parts } from '../dkim/forge.js';

export interface ArcSealOptions {
  readonly key: KeyObject;
  readonly algorithm?: DkimAlgorithm;
  readonly domain: string;
  readonly selector: string;
  /** authserv-id written in the AAR. */
  readonly authservId: string;
  /** The AAR's results, after the authserv-id, e.g. "dkim=pass header.i=@x; spf=pass ...". */
  readonly results: string;
  /** Headers the AMS signs. */
  readonly headers?: readonly string[];
  /** Override cv= (default: none for i=1, pass after). */
  readonly cv?: string;
  /** Override the instance (default: one more than the highest ARC-Seal present). */
  readonly instance?: number;
  /** Extra tags for the AS (e.g. { h: 'from' } for a malformed-seal fixture). */
  readonly sealTags?: Readonly<Record<string, string>>;
  readonly t?: number;
}

export const AMS_HEADERS = ['from', 'to', 'subject', 'date', 'message-id', 'dkim-signature', 'list-id'];

function text(f: HeaderField): string {
  return f.raw.toString('latin1');
}

function instanceOf(f: HeaderField): number {
  const m = /[\s;:]i\s*=\s*([0-9]+)/.exec(text(f));
  return m?.[1] === undefined ? 0 : Number(m[1]);
}

/** Return `message` with a new ARC set prepended (ARC-Seal, then AMS, then AAR, as Google writes them). */
export function arcSeal(message: string, opts: ArcSealOptions): string {
  const { head, body } = parts(message);
  const fields = parseHeaderFields(Buffer.from(head, 'latin1'));
  const existing = fields.filter((f) => f.key === 'arc-seal').map(instanceOf);
  const i = opts.instance ?? Math.max(0, ...existing) + 1;
  const algorithm = opts.algorithm ?? 'rsa-sha256';
  const t = String(opts.t ?? 1790000000);

  const aar = `ARC-Authentication-Results: i=${i}; ${opts.authservId};\r\n       ${opts.results}`;

  const headers = (opts.headers ?? AMS_HEADERS).filter((h) => fields.some((f) => f.key === h));
  const bh = createHash('sha256').update(canonicalizeBody(Buffer.from(body, 'latin1'), 'relaxed')).digest('base64');
  const amsUnsigned =
    `ARC-Message-Signature: i=${i}; a=${algorithm}; c=relaxed/relaxed; d=${opts.domain};\r\n` +
    `        s=${opts.selector}; t=${t};\r\n        h=${headers.join(':')};\r\n        bh=${bh};\r\n        b=`;
  const amsData = headerHashInput(fields, headers, amsUnsigned, 'relaxed');
  const ams = amsUnsigned + signHeaderData(algorithm, opts.key, amsData).toString('base64');

  const cv = opts.cv ?? (i === 1 ? 'none' : 'pass');
  const extra = Object.entries(opts.sealTags ?? {})
    .map(([k, v]) => ` ${k}=${v};`)
    .join('');
  const sealUnsigned = `ARC-Seal: i=${i}; a=${algorithm}; t=${t}; cv=${cv};${extra}\r\n        d=${opts.domain}; s=${opts.selector};\r\n        b=`;

  // Earlier sets, in instance order, from the message as it stands.
  const prior: ArcSetText[] = [];
  for (let k = 1; k < i; k++) {
    const pick = (key: string): string => {
      const f = fields.find((x) => x.key === key && instanceOf(x) === k);
      return f === undefined ? '' : text(f);
    };
    prior.push({ aar: pick('arc-authentication-results'), ams: pick('arc-message-signature'), seal: pick('arc-seal') });
  }
  const sealData = arcSealHashInput([...prior, { aar, ams, seal: sealUnsigned }]);
  const seal = sealUnsigned + signHeaderData(algorithm, opts.key, sealData).toString('base64');

  return `${seal}\r\n${ams}\r\n${aar}\r\n${head}\r\n${body}`;
}

/** Rebuild `message` without the header fields `drop` selects. */
export function dropFields(message: string, drop: (name: string, raw: string) => boolean): string {
  const { head, body } = parts(message);
  const kept = parseHeaderFields(Buffer.from(head, 'latin1'))
    .map(text)
    .filter((raw) => !drop(raw.slice(0, raw.indexOf(':')).toLowerCase(), raw));
  return `${kept.join('\r\n')}\r\n\r\n${body}`;
}

/** Replace text inside the one header field `pick` selects. */
export function editField(message: string, pick: (raw: string) => boolean, edit: (raw: string) => string): string {
  const { head, body } = parts(message);
  const fields = parseHeaderFields(Buffer.from(head, 'latin1')).map(text);
  const n = fields.findIndex(pick);
  if (n === -1) throw new Error('editField: no such field');
  fields[n] = edit(fields[n] ?? '');
  return `${fields.join('\r\n')}\r\n\r\n${body}`;
}
