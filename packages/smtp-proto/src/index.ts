// SMTP wire protocol: strict CRLF line reader, command parser, reply writer, reply parser,
// pipelining session engine with STARTTLS (RFC 5321, 1870, 2920, 3207, 3463, 4954, 6152, 6531).
export const PACKAGE = '@postroom/smtp-proto';

export * from './address.js';
export * from './command.js';
export * from './line-reader.js';
export * from './reply.js';
export * from './reply-parser.js';
export * from './session.js';
export * from './tls.js';
