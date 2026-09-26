// The direct MX delivery client (PST-T-1.6), hand-rolled on @postroom/smtp-proto.
export { createDirectTransport, DEFAULT_HELO_NAME } from './transport.js';
export type { DirectTransportOptions } from './transport.js';
export { classifyReply, RFC5321_TIMEOUTS } from './session.js';
export type { CommandTimeouts, Log, SmarthostAuth } from './session.js';
export { connectTcp, SmtpClientError, SmtpConnection } from './connection.js';
export type { ConnectOptions, Connector, FailureKind, Stage } from './connection.js';
export { DotStuffer } from './dot-stuff.js';
