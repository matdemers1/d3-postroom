// SMTP TLS Reporting — RFC 8460 §4 (PST-T-7.1, PST-REQ-122).
//
// `parseTlsRpt` reads the JSON report a sender mails to the domain's `_smtp._tls` rua address into a
// normalized shape; `serializeTlsRpt` writes it back, and the pair round-trips. Dates are RFC 3339
// on the wire and normalized to ISO 8601 UTC (`toISOString`). Unknown members are ignored. A
// structural miss is `not-tlsrpt`, a bad value `invalid-field`, bad JSON `json-syntax`; nothing but
// ReportError is thrown.
import { ReportError } from './errors.js';

export type TlsPolicyType = 'sts' | 'tlsa' | 'no-policy-found';

export interface TlsRptFailure {
  readonly resultType: string;
  readonly sendingMtaIp: string | null;
  readonly receivingMxHostname: string | null;
  readonly receivingMxHelo: string | null;
  readonly receivingIp: string | null;
  readonly failedSessionCount: number;
  readonly additionalInformation: string | null;
  readonly failureReasonCode: string | null;
}

export interface TlsRptPolicy {
  readonly policyType: TlsPolicyType;
  readonly policyString: readonly string[];
  readonly policyDomain: string;
  readonly mxHost: readonly string[];
  readonly totalSuccessful: number;
  readonly totalFailure: number;
  readonly failures: readonly TlsRptFailure[];
}

export interface TlsRptReport {
  readonly organizationName: string;
  /** ISO 8601 UTC. */
  readonly start: string;
  readonly end: string;
  readonly contactInfo: string | null;
  readonly reportId: string;
  readonly policies: readonly TlsRptPolicy[];
}

export interface TlsRptParseOptions {
  /** Bytes of JSON accepted (default 16 MiB). */
  maxBytes?: number;
  /** Policies, and failure-details per policy, accepted (default 10 000 each). */
  maxItems?: number;
}

export const DEFAULT_MAX_TLSRPT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_TLSRPT_ITEMS = 10_000;
const MAX_COUNT = 2_147_483_647;
const MAX_FIELD = 1024;
const POLICY_TYPES: readonly string[] = ['sts', 'tlsa', 'no-policy-found'];
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function missing(path: string): never {
  throw new ReportError('not-tlsrpt', `missing "${path}"`);
}

function invalid(path: string, value: unknown): never {
  const shown = typeof value === 'string' ? value.slice(0, 64) : typeof value;
  throw new ReportError('invalid-field', `"${path}" has an invalid value (${shown})`);
}

function own(o: Obj, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

function str(o: Obj, key: string, path: string): string {
  const v = own(o, key);
  if (v === undefined || v === null) missing(path);
  if (typeof v !== 'string') invalid(path, v);
  const t = v.trim();
  if (t === '' || t.length > MAX_FIELD) invalid(path, v);
  return t;
}

function optStr(o: Obj, key: string, path: string): string | null {
  const v = own(o, key);
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') invalid(path, v);
  const t = v.trim();
  if (t.length > MAX_FIELD) invalid(path, v);
  return t === '' ? null : t;
}

function count(o: Obj, key: string, path: string): number {
  const v = own(o, key);
  if (v === undefined || v === null) missing(path);
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_COUNT) invalid(path, v);
  return v;
}

function strList(o: Obj, key: string, path: string, max: number): string[] {
  const v = own(o, key);
  if (v === undefined || v === null) return [];
  // Some senders write a lone string where the RFC says an array.
  const list: unknown[] = Array.isArray(v) ? v : [v];
  if (list.length > max) throw new ReportError('too-many', `"${path}" has more than ${String(max)} entries`);
  return list.map((item) => {
    if (typeof item !== 'string' || item.length > MAX_FIELD) invalid(path, item);
    return item.trim();
  }).filter((s) => s !== '');
}

function dateTime(o: Obj, key: string, path: string): string {
  const s = str(o, key, path);
  if (!RFC3339.test(s)) invalid(path, s);
  const t = Date.parse(s.replace(' ', 'T'));
  if (Number.isNaN(t)) invalid(path, s);
  return new Date(t).toISOString();
}

function list(o: Obj, key: string, path: string, max: number, required: boolean): Obj[] {
  const v = own(o, key);
  if (v === undefined || v === null) {
    if (required) missing(path);
    return [];
  }
  if (!Array.isArray(v)) invalid(path, v);
  if (v.length > max) throw new ReportError('too-many', `"${path}" has more than ${String(max)} entries`);
  return v.map((item) => (isObj(item) ? item : invalid(path, item)));
}

function readFailure(f: Obj): TlsRptFailure {
  const p = 'failure-details[]';
  return {
    resultType: str(f, 'result-type', `${p}.result-type`).toLowerCase(),
    sendingMtaIp: optStr(f, 'sending-mta-ip', `${p}.sending-mta-ip`),
    receivingMxHostname: optStr(f, 'receiving-mx-hostname', `${p}.receiving-mx-hostname`)?.toLowerCase() ?? null,
    receivingMxHelo: optStr(f, 'receiving-mx-helo', `${p}.receiving-mx-helo`),
    receivingIp: optStr(f, 'receiving-ip', `${p}.receiving-ip`),
    failedSessionCount: count(f, 'failed-session-count', `${p}.failed-session-count`),
    additionalInformation: optStr(f, 'additional-information', `${p}.additional-information`),
    failureReasonCode: optStr(f, 'failure-reason-code', `${p}.failure-reason-code`),
  };
}

function readPolicy(entry: Obj, max: number): TlsRptPolicy {
  const policy = own(entry, 'policy');
  if (!isObj(policy)) missing('policies[].policy');
  const summary = own(entry, 'summary');
  if (!isObj(summary)) missing('policies[].summary');
  const type = str(policy, 'policy-type', 'policy.policy-type').toLowerCase();
  if (!POLICY_TYPES.includes(type)) invalid('policy.policy-type', type);
  return {
    policyType: type as TlsPolicyType,
    policyString: strList(policy, 'policy-string', 'policy.policy-string', max),
    policyDomain: str(policy, 'policy-domain', 'policy.policy-domain').toLowerCase(),
    mxHost: strList(policy, 'mx-host', 'policy.mx-host', max).map((h) => h.toLowerCase()),
    totalSuccessful: count(summary, 'total-successful-session-count', 'summary.total-successful-session-count'),
    totalFailure: count(summary, 'total-failure-session-count', 'summary.total-failure-session-count'),
    failures: list(entry, 'failure-details', 'policies[].failure-details', max, false).map(readFailure),
  };
}

/** Reads an already-decoded JSON value. */
export function readTlsRpt(value: unknown, options: TlsRptParseOptions = {}): TlsRptReport {
  if (!isObj(value)) throw new ReportError('not-tlsrpt', 'a TLS-RPT report is a JSON object');
  const max = options.maxItems ?? DEFAULT_MAX_TLSRPT_ITEMS;
  const range = own(value, 'date-range');
  if (!isObj(range)) missing('date-range');
  const start = dateTime(range, 'start-datetime', 'date-range.start-datetime');
  const end = dateTime(range, 'end-datetime', 'date-range.end-datetime');
  if (end < start) invalid('date-range.end-datetime', end);
  return {
    organizationName: str(value, 'organization-name', 'organization-name'),
    start,
    end,
    contactInfo: optStr(value, 'contact-info', 'contact-info'),
    reportId: str(value, 'report-id', 'report-id'),
    policies: list(value, 'policies', 'policies', max, true).map((p) => readPolicy(p, max)),
  };
}

/** Parses a TLS-RPT JSON report. Throws ReportError, and only ReportError. */
export function parseTlsRpt(json: string | Uint8Array, options: TlsRptParseOptions = {}): TlsRptReport {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TLSRPT_BYTES;
  const size = typeof json === 'string' ? json.length : json.byteLength;
  if (size > maxBytes) throw new ReportError('too-large', `TLS-RPT JSON is over ${String(maxBytes)} bytes`);
  let text: string;
  try {
    text = typeof json === 'string' ? json : new TextDecoder('utf-8', { fatal: true }).decode(json);
  } catch {
    throw new ReportError('json-syntax', 'TLS-RPT JSON is not valid UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ReportError('json-syntax', 'TLS-RPT report is not valid JSON');
  }
  return readTlsRpt(value, options);
}

/** Writes a report as RFC 8460 JSON. `parseTlsRpt` of the result equals `report`. */
export function serializeTlsRpt(report: TlsRptReport): string {
  const opt = (key: string, v: string | null): Record<string, string> => (v === null ? {} : { [key]: v });
  return JSON.stringify({
    'organization-name': report.organizationName,
    'date-range': { 'start-datetime': report.start, 'end-datetime': report.end },
    ...opt('contact-info', report.contactInfo),
    'report-id': report.reportId,
    policies: report.policies.map((p) => ({
      policy: {
        'policy-type': p.policyType,
        'policy-string': p.policyString,
        'policy-domain': p.policyDomain,
        'mx-host': p.mxHost,
      },
      summary: { 'total-successful-session-count': p.totalSuccessful, 'total-failure-session-count': p.totalFailure },
      'failure-details': p.failures.map((f) => ({
        'result-type': f.resultType,
        ...opt('sending-mta-ip', f.sendingMtaIp),
        ...opt('receiving-mx-hostname', f.receivingMxHostname),
        ...opt('receiving-mx-helo', f.receivingMxHelo),
        ...opt('receiving-ip', f.receivingIp),
        'failed-session-count': f.failedSessionCount,
        ...opt('additional-information', f.additionalInformation),
        ...opt('failure-reason-code', f.failureReasonCode),
      })),
    })),
  });
}
