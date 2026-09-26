// Streaming RFC 5322/MIME parser: multipart, transfer encodings, RFC 2047/2231, charsets, bounded memory.
export const PACKAGE = '@postroom/mime';

export {
  parseMessage,
  MimeParser,
  MAX_BOUNDARY_LENGTH,
  type MessageSource,
  type MimeEvent,
  type MimeWarning,
  type ParseOptions,
  type ParseStats,
  type PartInfo,
  type PartKind,
  type WarningCode,
} from './parser.js';
export { collectMessage, type AttachmentSummary, type BodySummary, type CollectOptions, type MessageSummary } from './collect.js';
export { HeaderList, parseHeaderBlock, decodeHeaderBytes, unfold, type HeaderField } from './header.js';
export { decodeEncodedWords, decodeEncodedWordsDetailed, encodeWords, type EncodedWordResult } from './encoded-word.js';
export { parseContentType, parseContentDisposition, parseParams, stripComments, type ContentType, type ContentDisposition, type Params } from './params.js';
export { parseAddressList, parseMailboxes, type AddressEntry, type Group, type Mailbox } from './address.js';
export { parseDate } from './date.js';
export { parseMessageId, parseMessageIdList } from './msgid.js';
export { resolveCharset, decodeBytes, TextPartDecoder, type DecodedText } from './charset.js';
export {
  Base64Decoder,
  QuotedPrintableDecoder,
  IdentityDecoder,
  Base64Encoder,
  createTransferDecoder,
  normalizeEncoding,
  encodeBase64,
  encodeQuotedPrintable,
  type TransferDecoder,
  type QpEncodeOptions,
} from './transfer.js';
export {
  encodeHeaderValue,
  formatHeader,
  formatMailbox,
  buildMessage,
  generateBoundary,
  type EncodeHeaderOptions,
  type HeaderInput,
  type BodyEncoding,
  type LeafSpec,
  type MultipartSpec,
  type MessagePartSpec,
  type PartSpec,
  type MessageSpec,
} from './writer.js';
