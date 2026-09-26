// IMAP import (PST-T-10.2, PST-REQ-152): folders from another IMAP server into an account, with
// progress and resume. Mounted by apps/worker/src/main.ts on the 'import' queue, in its own block.
export { fetchItems, importHandler, listEntry, runImportJob, type ImportDeps, type ImportFaults } from './job.js';
export { capabilitiesOf, ImapImportClient, ImportError, type ImapConnectOptions, type ImportErrorKind } from './client.js';
export {
  astring,
  canonicalFingerprint,
  displayName,
  normalizeFingerprint,
  parseInternalDate,
  targetFor,
  uidSet,
  type FolderTarget,
  type SourceFolder,
} from './names.js';
export {
  IMPORT_CANCEL_PREFIX,
  IMPORT_QUEUE,
  IMPORT_SECRET_PREFIX,
  IMPORT_STATE_PREFIX,
  importCancelKey,
  importSecretKey,
  importStateKey,
  importTotals,
  readImportState,
  sealImportSecret,
  writeImportState,
  type ImportFolderProgress,
  type ImportState,
  type ImportStatus,
} from './state.js';
