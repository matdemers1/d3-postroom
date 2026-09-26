// WebDAV / CalDAV / CardDAV wire protocol, hand-rolled (PST-T-8.2, PST-REQ-132, PST-REQ-133): a
// strict XML parser and serializer for the DAV namespace subset (no DTDs, so no XXE and no entity
// expansion), multistatus bodies, typed request bodies, and the HTTP helpers DAV leans on.
export const PACKAGE = '@postroom/dav-proto';

export { DavError, DavRequestError, XmlError, type XmlErrorCode } from './errors.js';
export { NS, PREFERRED_PREFIXES, clark, parseClark } from './ns.js';
export {
  DEFAULT_MAX_XML_ATTRIBUTES,
  DEFAULT_MAX_XML_BYTES,
  DEFAULT_MAX_XML_DEPTH,
  DEFAULT_MAX_XML_NODES,
  attribute,
  childElement,
  childElements,
  el,
  isElement,
  isNcName,
  isXmlChar,
  parseXml,
  textContent,
  type XmlAttribute,
  type XmlElement,
  type XmlNode,
  type XmlParseOptions,
} from './xml.js';
export { escapeAttribute, escapeText, serializeXml, type SerializeOptions } from './serialize.js';
export {
  davError,
  emptyElement,
  groupPropstats,
  hrefElement,
  multistatus,
  statusLine,
  type MultiStatusResponse,
  type PropStat,
} from './multistatus.js';
export {
  PROPFIND_FINITE_DEPTH,
  decodePath,
  encodeSegment,
  evaluatePreconditions,
  formatEtag,
  hrefOf,
  hrefPath,
  parseDepth,
  parseEtagList,
  type DecodedPath,
  type Depth,
  type EntityTag,
  type Preconditions,
} from './http.js';
export {
  COLLATIONS,
  foldForCollation,
  formatUtcDateTime,
  isCollation,
  parseUtcDateTime,
  textMatches,
  type Collation,
  type MatchType,
  type TextMatch,
} from './match.js';
export {
  MAX_MULTIGET_HREFS,
  parseMkcol,
  parsePropChoice,
  parsePropfind,
  parseProppatch,
  parseReport,
  type AddressbookQuery,
  type CalendarQuery,
  type CardFilter,
  type CompFilter,
  type Multiget,
  type ParamFilter,
  type PropFilter,
  type PropRequest,
  type PropUpdate,
  type Report,
  type SyncCollection,
  type TimeRange,
  type UnsupportedReport,
} from './requests.js';
