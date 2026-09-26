// DMARC aggregate (RFC 7489 Appendix C) and TLS-RPT (RFC 8460) reports, hand-rolled (PST-T-7.1,
// PST-REQ-122): a strict XXE-proof XML reader, bounded gzip/zip unwrapping and normalized shapes.
export const PACKAGE = '@postroom/reports';

export { ReportError, type ReportErrorCode } from './errors.js';
export {
  DEFAULT_MAX_XML_ATTRIBUTES,
  DEFAULT_MAX_XML_BYTES,
  DEFAULT_MAX_XML_DEPTH,
  DEFAULT_MAX_XML_NODES,
  child,
  children,
  decodeEntities,
  escapeXml,
  isXmlChar,
  parseXml,
  type XmlElement,
  type XmlParseOptions,
} from './xml.js';
export {
  DEFAULT_MAX_DMARC_RECORDS,
  MAX_COUNT,
  dmarcPassed,
  parseDmarcAggregate,
  readDmarcAggregate,
  serializeDmarcAggregate,
  type DmarcAggregateReport,
  type DmarcAlignedResult,
  type DmarcDisposition,
  type DmarcDkimAuth,
  type DmarcParseOptions,
  type DmarcPolicyPublished,
  type DmarcReasonJson,
  type DmarcRecord,
  type DmarcSpfAuth,
} from './dmarc.js';
export {
  DEFAULT_MAX_TLSRPT_BYTES,
  DEFAULT_MAX_TLSRPT_ITEMS,
  parseTlsRpt,
  readTlsRpt,
  serializeTlsRpt,
  type TlsPolicyType,
  type TlsRptFailure,
  type TlsRptParseOptions,
  type TlsRptPolicy,
  type TlsRptReport,
} from './tlsrpt.js';
export {
  DEFAULT_MAX_INPUT,
  DEFAULT_MAX_OUTPUT,
  MAX_ZIP_ENTRIES,
  gunzipBounded,
  looksLikeReport,
  readZipReport,
  unwrapReport,
  type ReportAttachment,
  type ReportContainer,
  type ReportKind,
  type UnwrapOptions,
  type UnwrappedReport,
} from './unwrap.js';
export { parseReportAttachment, type ParsedReport } from './report.js';
