// vCard (RFC 6350 v4, tolerant of v3 and v2.1) parser, serializer and contact helpers — hand-rolled,
// no dependencies. PST-T-8.1 for PST-REQ-133 (CardDAV) and PST-REQ-088 (property tests + fuzz).
export const PACKAGE = '@postroom/vcard';

export { VCardError, VCardLimitError, VCardParseError } from './errors.js';
export { decodeParamValue, encodeParamValue, escapeText, fold, FOLD_OCTETS, splitUnescaped, unescapeText, unfold, utf8Length } from './lexer.js';
export type { Params } from './lexer.js';
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_LINES,
  getParam,
  getProperties,
  getProperty,
  isQuotedPrintable,
  parseVCard,
  parseVCards,
  serializeVCard,
  versionOf,
} from './card.js';
export type { ParseOptions, VCard, VCardProperty } from './card.js';
export {
  addressesOf,
  decodeQuotedPrintable,
  displayName,
  emailsOf,
  nameOf,
  parseDataUri,
  photoOf,
  prefOf,
  rawText,
  structuredOf,
  telsOf,
  textOf,
  typesOf,
} from './values.js';
export type { Address, DataUri, Email, Photo, StructuredName, Telephone } from './values.js';
