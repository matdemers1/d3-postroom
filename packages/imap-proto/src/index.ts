// IMAP4rev1/rev2 wire protocol (PST-REQ-070): a streaming command reader with literals, LITERAL+
// and LITERAL-, a typed command parser and formatter, a response writer with streaming literals,
// and a client-side response reader.
export const PACKAGE = '@postroom/imap-proto';

export * from './ast.js';
export * from './format.js';
export { isAstringChar, isAtomChar, isListChar, isTagChar } from './lexer.js';
export * from './mutf7.js';
export * from './parser.js';
export * from './reader.js';
export * from './response-parser.js';
export * from './response-stream.js';
export * from './sequence.js';
export * from './writer.js';
