// The Deliverability screen's numbers (PST-T-7.1, PST-REQ-122), aggregated in SQL over the rows the
// worker's report sweep stores (apps/worker/src/reports). DMARC passes for a row when the aligned
// DKIM or the aligned SPF result passed (RFC 7489 §6.6.2); a row's `count` is the number of
// messages it stands for. Days are UTC, and a report counts on the day its date range begins.
//
// A report the worker classified `foreign` (PST-T-7.9, PST-REQ-122: its policy domain is not one
// of our Domain rows) is excluded from every one of these queries — `d.status = 'ours'` /
// `t.status = 'ours'` on every FROM. It is still stored and visible in the raw table, just never
// counted toward "how is my domain doing".
import type { Db } from '@postroom/db';

export interface DmarcTotals {
  reports: number;
  messages: number;
  pass: number;
  fail: number;
  dkimPass: number;
  spfPass: number;
  dispositions: { none: number; quarantine: number; reject: number };
}

export interface DayRow {
  /** YYYY-MM-DD, UTC. */
  day: string;
  pass: number;
  fail: number;
}

export interface SourceRow {
  sourceIp: string;
  /** PTR name when a lookup found one, else null. */
  reverseDns: string | null;
  messages: number;
  pass: number;
  fail: number;
  /** pass / messages, 0..1. */
  passRate: number;
  dkimPass: number;
  spfPass: number;
  /** Reporting organizations that saw this source. */
  orgs: string[];
  headerFrom: string[];
}

export interface OrgRow {
  org: string;
  reports: number;
  messages: number;
  pass: number;
  fail: number;
}

export interface ReportRow {
  id: string;
  org: string;
  reportId: string;
  domain: string;
  begin: string;
  end: string;
  messages: number;
}

export interface TlsPolicyRow {
  policyDomain: string;
  policyType: string;
  successful: number;
  failed: number;
}

export interface TlsFailureRow {
  resultType: string;
  sessions: number;
}

export interface TlsReportRow {
  id: string;
  org: string;
  reportId: string;
  begin: string;
  end: string;
  successful: number;
  failed: number;
}

export interface Deliverability {
  range: { from: string; to: string; days: number };
  dmarc: { totals: DmarcTotals; byDay: DayRow[]; bySource: SourceRow[]; byOrg: OrgRow[]; reports: ReportRow[] };
  tlsrpt: { totals: { reports: number; successful: number; failed: number }; byPolicy: TlsPolicyRow[]; byFailureType: TlsFailureRow[]; reports: TlsReportRow[] };
}

const n = (v: bigint | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
const PASS = `(coalesce(r.dkim, '') = 'pass' OR coalesce(r.spf, '') = 'pass')`;

export async function aggregate(db: Db, from: Date, to: Date, sourceLimit = 100): Promise<Omit<Deliverability, 'range'>> {
  type TotalsRow = { reports: bigint; messages: bigint | null; pass: bigint | null; dkim_pass: bigint | null; spf_pass: bigint | null; d_none: bigint | null; d_quarantine: bigint | null; d_reject: bigint | null };
  const totals = (
    await db.$queryRawUnsafe<TotalsRow[]>(
      `SELECT count(DISTINCT d.id) AS reports, sum(r.count) AS messages,
              sum(r.count) FILTER (WHERE ${PASS}) AS pass,
              sum(r.count) FILTER (WHERE r.dkim = 'pass') AS dkim_pass,
              sum(r.count) FILTER (WHERE r.spf = 'pass') AS spf_pass,
              sum(r.count) FILTER (WHERE r.disposition = 'none') AS d_none,
              sum(r.count) FILTER (WHERE r.disposition = 'quarantine') AS d_quarantine,
              sum(r.count) FILTER (WHERE r.disposition = 'reject') AS d_reject
       FROM dmarc_report d LEFT JOIN dmarc_record r ON r.report_id = d.id
       WHERE d.status = 'ours' AND d.range_end >= $1 AND d.range_begin <= $2`,
      from,
      to,
    )
  )[0];

  const byDay = await db.$queryRawUnsafe<{ day: string; pass: bigint | null; fail: bigint | null }[]>(
    `SELECT to_char(d.range_begin AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            sum(r.count) FILTER (WHERE ${PASS}) AS pass,
            sum(r.count) FILTER (WHERE NOT ${PASS}) AS fail
     FROM dmarc_report d JOIN dmarc_record r ON r.report_id = d.id
     WHERE d.status = 'ours' AND d.range_end >= $1 AND d.range_begin <= $2
     GROUP BY 1 ORDER BY 1`,
    from,
    to,
  );

  const bySource = await db.$queryRawUnsafe<{ source_ip: string; messages: bigint; pass: bigint | null; dkim_pass: bigint | null; spf_pass: bigint | null; orgs: string[]; header_from: string[] }[]>(
    `SELECT r.source_ip, sum(r.count) AS messages,
            sum(r.count) FILTER (WHERE ${PASS}) AS pass,
            sum(r.count) FILTER (WHERE r.dkim = 'pass') AS dkim_pass,
            sum(r.count) FILTER (WHERE r.spf = 'pass') AS spf_pass,
            array_agg(DISTINCT d.org_name ORDER BY d.org_name) AS orgs,
            array_agg(DISTINCT r.header_from ORDER BY r.header_from) AS header_from
     FROM dmarc_report d JOIN dmarc_record r ON r.report_id = d.id
     WHERE d.status = 'ours' AND d.range_end >= $1 AND d.range_begin <= $2
     GROUP BY r.source_ip ORDER BY messages DESC, r.source_ip LIMIT $3`,
    from,
    to,
    sourceLimit,
  );

  const byOrg = await db.$queryRawUnsafe<{ org: string; reports: bigint; messages: bigint | null; pass: bigint | null }[]>(
    `SELECT d.org_name AS org, count(DISTINCT d.id) AS reports, sum(r.count) AS messages,
            sum(r.count) FILTER (WHERE ${PASS}) AS pass
     FROM dmarc_report d LEFT JOIN dmarc_record r ON r.report_id = d.id
     WHERE d.status = 'ours' AND d.range_end >= $1 AND d.range_begin <= $2
     GROUP BY d.org_name ORDER BY messages DESC NULLS LAST, d.org_name`,
    from,
    to,
  );

  const reports = await db.$queryRawUnsafe<{ id: string; org: string; report_id: string; domain: string; range_begin: Date; range_end: Date; messages: bigint | null }[]>(
    `SELECT d.id::text AS id, d.org_name AS org, d.report_id, d.domain, d.range_begin, d.range_end, sum(r.count) AS messages
     FROM dmarc_report d LEFT JOIN dmarc_record r ON r.report_id = d.id
     WHERE d.status = 'ours' AND d.range_end >= $1 AND d.range_begin <= $2
     GROUP BY d.id ORDER BY d.range_begin DESC, d.org_name LIMIT 50`,
    from,
    to,
  );

  const tlsTotals = (
    await db.$queryRawUnsafe<{ reports: bigint; successful: bigint | null; failed: bigint | null }[]>(
      `SELECT count(DISTINCT t.id) AS reports, sum(p.success_count) AS successful, sum(p.failure_count) AS failed
       FROM tlsrpt_report t LEFT JOIN tlsrpt_policy p ON p.report_id = t.id
       WHERE t.status = 'ours' AND t.range_end >= $1 AND t.range_begin <= $2`,
      from,
      to,
    )
  )[0];

  const byPolicy = await db.$queryRawUnsafe<{ policy_domain: string; policy_type: string; successful: bigint; failed: bigint }[]>(
    `SELECT p.policy_domain, p.policy_type, sum(p.success_count) AS successful, sum(p.failure_count) AS failed
     FROM tlsrpt_report t JOIN tlsrpt_policy p ON p.report_id = t.id
     WHERE t.status = 'ours' AND t.range_end >= $1 AND t.range_begin <= $2
     GROUP BY 1, 2 ORDER BY 1, 2`,
    from,
    to,
  );

  const byFailureType = await db.$queryRawUnsafe<{ result_type: string; sessions: bigint }[]>(
    `SELECT f.result_type, sum(f.failed_session_count) AS sessions
     FROM tlsrpt_report t JOIN tlsrpt_policy p ON p.report_id = t.id JOIN tlsrpt_failure f ON f.policy_id = p.id
     WHERE t.status = 'ours' AND t.range_end >= $1 AND t.range_begin <= $2
     GROUP BY 1 ORDER BY sessions DESC, 1`,
    from,
    to,
  );

  const tlsReports = await db.$queryRawUnsafe<{ id: string; org: string; report_id: string; range_begin: Date; range_end: Date; successful: bigint | null; failed: bigint | null }[]>(
    `SELECT t.id::text AS id, t.org_name AS org, t.report_id, t.range_begin, t.range_end,
            sum(p.success_count) AS successful, sum(p.failure_count) AS failed
     FROM tlsrpt_report t LEFT JOIN tlsrpt_policy p ON p.report_id = t.id
     WHERE t.status = 'ours' AND t.range_end >= $1 AND t.range_begin <= $2
     GROUP BY t.id ORDER BY t.range_begin DESC, t.org_name LIMIT 50`,
    from,
    to,
  );

  const messages = n(totals?.messages);
  const pass = n(totals?.pass);
  return {
    dmarc: {
      totals: {
        reports: n(totals?.reports),
        messages,
        pass,
        fail: messages - pass,
        dkimPass: n(totals?.dkim_pass),
        spfPass: n(totals?.spf_pass),
        dispositions: { none: n(totals?.d_none), quarantine: n(totals?.d_quarantine), reject: n(totals?.d_reject) },
      },
      byDay: byDay.map((d) => ({ day: d.day, pass: n(d.pass), fail: n(d.fail) })),
      bySource: bySource.map((s) => {
        const m = n(s.messages);
        const p = n(s.pass);
        return { sourceIp: s.source_ip, reverseDns: null, messages: m, pass: p, fail: m - p, passRate: m === 0 ? 0 : p / m, dkimPass: n(s.dkim_pass), spfPass: n(s.spf_pass), orgs: s.orgs, headerFrom: s.header_from };
      }),
      byOrg: byOrg.map((o) => ({ org: o.org, reports: n(o.reports), messages: n(o.messages), pass: n(o.pass), fail: n(o.messages) - n(o.pass) })),
      reports: reports.map((r) => ({ id: r.id, org: r.org, reportId: r.report_id, domain: r.domain, begin: r.range_begin.toISOString(), end: r.range_end.toISOString(), messages: n(r.messages) })),
    },
    tlsrpt: {
      totals: { reports: n(tlsTotals?.reports), successful: n(tlsTotals?.successful), failed: n(tlsTotals?.failed) },
      byPolicy: byPolicy.map((p) => ({ policyDomain: p.policy_domain, policyType: p.policy_type, successful: n(p.successful), failed: n(p.failed) })),
      byFailureType: byFailureType.map((f) => ({ resultType: f.result_type, sessions: n(f.sessions) })),
      reports: tlsReports.map((t) => ({ id: t.id, org: t.org, reportId: t.report_id, begin: t.range_begin.toISOString(), end: t.range_end.toISOString(), successful: n(t.successful), failed: n(t.failed) })),
    },
  };
}
