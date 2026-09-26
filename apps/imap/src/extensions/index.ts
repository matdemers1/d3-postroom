// IMAP extensions registered with the daemon (PST-T-3.3 fills this in: IDLE, CONDSTORE, QRESYNC, …).
// Each is an `ImapExtension` (see ../capabilities.ts): capability names, ENABLE names, and command
// handlers that replace the core's. The daemon passes this list to its CapabilityRegistry.
import type { ImapExtension } from '../capabilities.js';

export const EXTENSIONS: readonly ImapExtension[] = [];
