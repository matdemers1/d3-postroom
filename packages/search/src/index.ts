// Mail search: an operator query parser and a SQL builder over message_search, shared by the API
// and IMAP SEARCH (PST-T-3.7, PST-REQ-080).
export const PACKAGE = '@postroom/search';

export { OPERATOR_NAMES, isOperatorName, type LeafNode, type OperatorName, type ParseResult, type QueryAst, type QueryNode } from './ast.js';
export { parseQuery } from './parser.js';
export { formatQuery } from './format.js';
export { buildSearchSql, parseDateValue, searchMessages, type SearchOptions, type SearchRow } from './sql.js';
export { htmlToText, indexMessage, truncateUtf8, type IndexMessageInput } from './index-message.js';
export { imapSearchToAst, imapTextCriteriaSql, type ImapTextCriterion, type ImapTextKey } from './imap.js';
