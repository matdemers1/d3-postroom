// The one error class parseInvite/buildReply ever throw — a malformed or unsupported calendar
// object is refused, never crashes the caller.
export class ImipError extends Error {}
