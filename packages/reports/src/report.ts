// One call from a mail attachment to a parsed report (PST-T-7.1): unwrap, then parse by kind.
import { parseDmarcAggregate, type DmarcAggregateReport } from './dmarc.js';
import { parseTlsRpt, type TlsRptReport } from './tlsrpt.js';
import { unwrapReport, type ReportAttachment, type ReportContainer, type UnwrapOptions } from './unwrap.js';

export type ParsedReport =
  | { readonly kind: 'dmarc'; readonly container: ReportContainer; readonly name: string | null; readonly report: DmarcAggregateReport }
  | { readonly kind: 'tlsrpt'; readonly container: ReportContainer; readonly name: string | null; readonly report: TlsRptReport };

/** Null when the attachment is not a report; ReportError when it is one and is broken. */
export function parseReportAttachment(attachment: ReportAttachment, options: UnwrapOptions = {}): ParsedReport | null {
  const unwrapped = unwrapReport(attachment, options);
  if (unwrapped === null) return null;
  const { container, name } = unwrapped;
  const maxBytes = options.maxOutput;
  if (unwrapped.kind === 'dmarc') {
    return { kind: 'dmarc', container, name, report: parseDmarcAggregate(unwrapped.bytes, maxBytes === undefined ? {} : { maxBytes }) };
  }
  return { kind: 'tlsrpt', container, name, report: parseTlsRpt(unwrapped.bytes, maxBytes === undefined ? {} : { maxBytes }) };
}
