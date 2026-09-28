// RFC 3464 delivery status notifications: delay and failure reports, and (PST-T-11.15) readers for
// the DSNs and ARF feedback reports that come back to us.
export const PACKAGE = '@postroom/dsn';

export { buildDsn, type BuildDsnInput, type DsnKind, type DsnRecipientReport } from './build.js';
export {
  fileLocalMessage,
  type FiledMessage,
  type FileLocalMessageInput,
  type FileLocalMessageTx,
} from './file-local-message.js';
export {
  parseDeliveryStatus,
  parseFeedbackReport,
  statusCode,
  smtpCodeOf,
  decodeXtext,
  DELIVERY_STATUS_TYPES,
  FEEDBACK_REPORT_TYPE,
  MAX_REPORT_BYTES,
  MAX_RECIPIENTS,
  MAX_FIELDS,
  MAX_VALUE_CHARS,
  type DeliveryStatusReport,
  type DsnRecipientStatus,
  type FeedbackReport,
  type TypedValue,
} from './report.js';
