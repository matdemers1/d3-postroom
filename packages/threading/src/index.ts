// JWZ message threading over Message-ID, References and In-Reply-To with a subject fallback
// (PST-REQ-078, PST-T-3.8).
export const PACKAGE = '@postroom/threading';

export { threadMessages, baseSubject, normalizeMsgId, type ThreadInput, type ThreadTree } from './jwz.js';
export { assignThread, type AssignThreadInput } from './assign.js';
