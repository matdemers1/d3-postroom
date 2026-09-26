// PST-T-7.1 (PST-REQ-122): DMARC aggregate and TLS-RPT reports mailed to the report mailboxes,
// read into normalized rows for the admin Deliverability screen.
export { reportAddresses, resolveReportMailboxes, type ReportMailboxes } from './config.js';
export { classifyDmarc, classifyTlsRpt, ourDomainNames, type Classified, type ReportStatus } from './domains.js';
export { extractCandidates, type Candidate, type ExtractOptions } from './extract.js';
export { outcomeOf, storeMessageReports, type AttachmentOutcome, type MessageOutcome, type ParsedAttachment } from './store.js';
export { createReportSweeper, readMessageReports, startReportLoop, type ReportLoop, type ReportSweepDeps, type ReportSweeper, type SweptMessage } from './sweep.js';
