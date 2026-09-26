// iMIP (RFC 6047) and iTIP (RFC 5546): invitations, replies and cancellations over mail.
export const PACKAGE = '@postroom/imip';

export { ImipError } from './errors.js';
export { IMIP_METHODS, parseInvite, replyBlockReason } from './parse.js';
export type { ImipMethod, InviteAttendee, InviteOrganizer, OrganizerStatus, ParsedInvite, Partstat } from './parse.js';
export { buildReply, matchAttendee, serializeReply } from './reply.js';
