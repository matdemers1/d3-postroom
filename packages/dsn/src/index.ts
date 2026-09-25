// RFC 3464 delivery status notifications: delay and failure reports.
export const PACKAGE = '@postroom/dsn';

export { buildDsn, type BuildDsnInput, type DsnKind, type DsnRecipientReport } from './build.js';
export {
  fileLocalMessage,
  type FiledMessage,
  type FileLocalMessageInput,
  type FileLocalMessageTx,
} from './file-local-message.js';
