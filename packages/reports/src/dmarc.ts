// DMARC aggregate reports — RFC 7489 Appendix C (PST-T-7.1, PST-REQ-122).
//
// `parseDmarcAggregate` reads the XML a receiver mails to the domain's `rua` address into a
// normalized, JSON-able shape; `serializeDmarcAggregate` writes that shape back as XML, so the pair
// round-trips (parse(serialize(r)) deep-equals r — a fast-check property and a fuzz invariant).
//
// Normalization: every field value is trimmed; enumerations, domains and IPv6 addresses are
// lowercased. Elements are matched by local name, so a namespaced report (the DMARCbis draft's
// `xmlns="urn:ietf:params:xml:ns:dmarc-2.0"`, or a prefix) reads the same as a bare one. Unknown
// elements (extensions) are ignored. A missing required element is `not-dmarc`; a value out of
// range is `invalid-field`. Nothing but ReportError is thrown.
import { isIP } from 'node:net';
import { ReportError } from './errors.js';
import { child, children, escapeXml, parseXml, type XmlElement, type XmlParseOptions } from './xml.js';

export type DmarcDisposition = 'none' | 'quarantine' | 'reject';
export type DmarcAlignedResult = 'pass' | 'fail';

export interface DmarcPolicyPublished {
  readonly domain: string;
  /** `r` relaxed or `s` strict; null when the report omits it. */
  readonly adkim: 'r' | 's' | null;
  readonly aspf: 'r' | 's' | null;
  readonly p: DmarcDisposition;
  readonly sp: DmarcDisposition | null;
  readonly pct: number | null;
  readonly fo: string | null;
}

export interface DmarcReasonJson {
  readonly type: string;
  readonly comment: string | null;
}

export interface DmarcDkimAuth {
  readonly domain: string;
  readonly selector: string | null;
  readonly result: string;
  readonly humanResult: string | null;
}

export interface DmarcSpfAuth {
  readonly domain: string;
  readonly scope: string | null;
  readonly result: string;
}

export interface DmarcRecord {
  readonly sourceIp: string;
  readonly count: number;
  readonly disposition: DmarcDisposition;
  /** policy_evaluated/dkim: whether an aligned DKIM signature passed. Null when omitted. */
  readonly dkim: DmarcAlignedResult | null;
  /** policy_evaluated/spf: whether an aligned SPF check passed. Null when omitted. */
  readonly spf: DmarcAlignedResult | null;
  readonly reasons: readonly DmarcReasonJson[];
  readonly headerFrom: string;
  readonly envelopeFrom: string | null;
  readonly envelopeTo: string | null;
  readonly authDkim: readonly DmarcDkimAuth[];
  readonly authSpf: readonly DmarcSpfAuth[];
}

export interface DmarcAggregateReport {
  readonly version: string | null;
  readonly orgName: string;
  readonly email: string | null;
  readonly extraContactInfo: string | null;
  readonly reportId: string;
  /** date_range/begin and end: seconds since the epoch, UTC. */
  readonly begin: number;
  readonly end: number;
  readonly errors: readonly string[];
  readonly policy: DmarcPolicyPublished;
  readonly records: readonly DmarcRecord[];
}

export interface DmarcParseOptions extends XmlParseOptions {
  /** Record rows accepted (default 100 000). */
  maxRecords?: number;
}

export const DEFAULT_MAX_DMARC_RECORDS = 100_000;
/** The count column is a 32-bit integer in the store; a larger count is refused, not wrapped. */
export const MAX_COUNT = 2_147_483_647;
const MAX_FIELD = 1024;
const DISPOSITIONS: readonly DmarcDisposition[] = ['none', 'quarantine', 'reject'];
const ALIGNED: readonly DmarcAlignedResult[] = ['pass', 'fail'];

function missing(path: string): never {
  throw new ReportError('not-dmarc', `missing <${path}>`);
}

function invalid(path: string, value: string): never {
  throw new ReportError('invalid-field', `<${path}> has an invalid value "${value.slice(0, 64)}"`);
}

function text(el: XmlElement, path: string): string {
  const v = el.text.trim();
  if (v.length > MAX_FIELD) invalid(path, v);
  return v;
}

function req(parent: XmlElement, local: string, path: string): XmlElement {
  return child(parent, local) ?? missing(path);
}

function reqText(parent: XmlElement, local: string, path: string): string {
  const v = text(req(parent, local, path), path);
  if (v === '') missing(path);
  return v;
}

function optText(parent: XmlElement, local: string, path: string): string | null {
  const el = child(parent, local);
  if (el === undefined) return null;
  const v = text(el, path);
  return v === '' ? null : v;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], path: string): T {
  const v = value.toLowerCase();
  if (!(allowed as readonly string[]).includes(v)) invalid(path, value);
  return v as T;
}

function uint(value: string, path: string, max: number): number {
  if (!/^[0-9]{1,15}$/.test(value)) invalid(path, value);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > max) invalid(path, value);
  return n;
}

function token(value: string, path: string): string {
  const v = value.toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(v)) invalid(path, value);
  return v;
}

function domain(value: string, path: string): string {
  const v = value.toLowerCase();
  if (v.length > 255 || /[\s<>"]/.test(v)) invalid(path, value);
  return v;
}

function readRecord(rec: XmlElement): DmarcRecord {
  const row = req(rec, 'row', 'record/row');
  const sourceIpRaw = reqText(row, 'source_ip', 'row/source_ip');
  if (isIP(sourceIpRaw) === 0) invalid('row/source_ip', sourceIpRaw);
  const count = uint(reqText(row, 'count', 'row/count'), 'row/count', MAX_COUNT);
  const pe = req(row, 'policy_evaluated', 'row/policy_evaluated');
  const disposition = oneOf(reqText(pe, 'disposition', 'policy_evaluated/disposition'), DISPOSITIONS, 'policy_evaluated/disposition');
  const dkimRaw = optText(pe, 'dkim', 'policy_evaluated/dkim');
  const spfRaw = optText(pe, 'spf', 'policy_evaluated/spf');
  const reasons = children(pe, 'reason').map((r) => ({
    type: token(reqText(r, 'type', 'reason/type'), 'reason/type'),
    comment: optText(r, 'comment', 'reason/comment'),
  }));

  const ids = req(rec, 'identifiers', 'record/identifiers');
  const envelopeFrom = optText(ids, 'envelope_from', 'identifiers/envelope_from');
  const envelopeTo = optText(ids, 'envelope_to', 'identifiers/envelope_to');

  const auth = child(rec, 'auth_results');
  const authDkim = auth === undefined ? [] : children(auth, 'dkim').map((d) => ({
    domain: domain(reqText(d, 'domain', 'auth_results/dkim/domain'), 'auth_results/dkim/domain'),
    selector: optText(d, 'selector', 'auth_results/dkim/selector'),
    result: token(reqText(d, 'result', 'auth_results/dkim/result'), 'auth_results/dkim/result'),
    humanResult: optText(d, 'human_result', 'auth_results/dkim/human_result'),
  }));
  const authSpf = auth === undefined ? [] : children(auth, 'spf').map((s) => {
    const scope = optText(s, 'scope', 'auth_results/spf/scope');
    return {
      domain: domain(reqText(s, 'domain', 'auth_results/spf/domain'), 'auth_results/spf/domain'),
      scope: scope === null ? null : token(scope, 'auth_results/spf/scope'),
      result: token(reqText(s, 'result', 'auth_results/spf/result'), 'auth_results/spf/result'),
    };
  });

  return {
    sourceIp: sourceIpRaw.toLowerCase(),
    count,
    disposition,
    dkim: dkimRaw === null ? null : oneOf(dkimRaw, ALIGNED, 'policy_evaluated/dkim'),
    spf: spfRaw === null ? null : oneOf(spfRaw, ALIGNED, 'policy_evaluated/spf'),
    reasons,
    headerFrom: domain(reqText(ids, 'header_from', 'identifiers/header_from'), 'identifiers/header_from'),
    envelopeFrom: envelopeFrom === null ? null : domain(envelopeFrom, 'identifiers/envelope_from'),
    envelopeTo: envelopeTo === null ? null : domain(envelopeTo, 'identifiers/envelope_to'),
    authDkim,
    authSpf,
  };
}

/** Reads an already-parsed `<feedback>` tree. */
export function readDmarcAggregate(root: XmlElement, options: DmarcParseOptions = {}): DmarcAggregateReport {
  if (root.local !== 'feedback') throw new ReportError('not-dmarc', `root element is <${root.name.slice(0, 40)}>, not <feedback>`);
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_DMARC_RECORDS;
  const meta = req(root, 'report_metadata', 'report_metadata');
  const range = req(meta, 'date_range', 'report_metadata/date_range');
  const begin = uint(reqText(range, 'begin', 'date_range/begin'), 'date_range/begin', 253_402_300_799);
  const end = uint(reqText(range, 'end', 'date_range/end'), 'date_range/end', 253_402_300_799);
  if (end < begin) invalid('date_range/end', String(end));

  const pp = req(root, 'policy_published', 'policy_published');
  const alignment = (local: string): 'r' | 's' | null => {
    const v = optText(pp, local, `policy_published/${local}`);
    return v === null ? null : oneOf<'r' | 's'>(v, ['r', 's'], `policy_published/${local}`);
  };
  const sp = optText(pp, 'sp', 'policy_published/sp');
  const pct = optText(pp, 'pct', 'policy_published/pct');
  const policy: DmarcPolicyPublished = {
    domain: domain(reqText(pp, 'domain', 'policy_published/domain'), 'policy_published/domain'),
    adkim: alignment('adkim'),
    aspf: alignment('aspf'),
    p: oneOf(reqText(pp, 'p', 'policy_published/p'), DISPOSITIONS, 'policy_published/p'),
    sp: sp === null ? null : oneOf(sp, DISPOSITIONS, 'policy_published/sp'),
    pct: pct === null ? null : uint(pct, 'policy_published/pct', 100),
    fo: optText(pp, 'fo', 'policy_published/fo'),
  };

  const recs = children(root, 'record');
  if (recs.length > maxRecords) throw new ReportError('too-many', `more than ${String(maxRecords)} records`);

  return {
    version: optText(root, 'version', 'version'),
    orgName: reqText(meta, 'org_name', 'report_metadata/org_name'),
    email: optText(meta, 'email', 'report_metadata/email'),
    extraContactInfo: optText(meta, 'extra_contact_info', 'report_metadata/extra_contact_info'),
    reportId: reqText(meta, 'report_id', 'report_metadata/report_id'),
    begin,
    end,
    errors: children(meta, 'error').map((e) => text(e, 'report_metadata/error')).filter((e) => e !== ''),
    policy,
    records: recs.map(readRecord),
  };
}

/** Parses a DMARC aggregate report's XML. Throws ReportError, and only ReportError. */
export function parseDmarcAggregate(xml: string | Uint8Array, options: DmarcParseOptions = {}): DmarcAggregateReport {
  return readDmarcAggregate(parseXml(xml, options), options);
}

const el = (name: string, value: string | number | null, indent: string): string =>
  value === null ? '' : `${indent}<${name}>${escapeXml(String(value))}</${name}>\n`;

/** Writes a report as RFC 7489 Appendix C XML. `parseDmarcAggregate` of the result equals `report`. */
export function serializeDmarcAggregate(report: DmarcAggregateReport): string {
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<feedback>\n';
  out += el('version', report.version, '  ');
  out += '  <report_metadata>\n';
  out += el('org_name', report.orgName, '    ');
  out += el('email', report.email, '    ');
  out += el('extra_contact_info', report.extraContactInfo, '    ');
  out += el('report_id', report.reportId, '    ');
  out += `    <date_range>\n${el('begin', report.begin, '      ')}${el('end', report.end, '      ')}    </date_range>\n`;
  for (const e of report.errors) out += el('error', e, '    ');
  out += '  </report_metadata>\n  <policy_published>\n';
  const p = report.policy;
  out += el('domain', p.domain, '    ') + el('adkim', p.adkim, '    ') + el('aspf', p.aspf, '    ') + el('p', p.p, '    ');
  out += el('sp', p.sp, '    ') + el('pct', p.pct, '    ') + el('fo', p.fo, '    ');
  out += '  </policy_published>\n';
  for (const r of report.records) {
    out += '  <record>\n    <row>\n';
    out += el('source_ip', r.sourceIp, '      ') + el('count', r.count, '      ');
    out += '      <policy_evaluated>\n';
    out += el('disposition', r.disposition, '        ') + el('dkim', r.dkim, '        ') + el('spf', r.spf, '        ');
    for (const reason of r.reasons) out += `        <reason>\n${el('type', reason.type, '          ')}${el('comment', reason.comment, '          ')}        </reason>\n`;
    out += '      </policy_evaluated>\n    </row>\n    <identifiers>\n';
    out += el('envelope_to', r.envelopeTo, '      ') + el('envelope_from', r.envelopeFrom, '      ') + el('header_from', r.headerFrom, '      ');
    out += '    </identifiers>\n    <auth_results>\n';
    for (const d of r.authDkim) {
      out += `      <dkim>\n${el('domain', d.domain, '        ')}${el('selector', d.selector, '        ')}${el('result', d.result, '        ')}${el('human_result', d.humanResult, '        ')}      </dkim>\n`;
    }
    for (const s of r.authSpf) out += `      <spf>\n${el('domain', s.domain, '        ')}${el('scope', s.scope, '        ')}${el('result', s.result, '        ')}      </spf>\n`;
    out += '    </auth_results>\n  </record>\n';
  }
  return `${out}</feedback>\n`;
}

/** DMARC passes for a row when an aligned DKIM or an aligned SPF check passed (RFC 7489 §6.6.2). */
export function dmarcPassed(record: Pick<DmarcRecord, 'dkim' | 'spf'>): boolean {
  return record.dkim === 'pass' || record.spf === 'pass';
}
