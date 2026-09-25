// Message authentication: DKIM signing now; SPF, DKIM verify, DMARC and ARC in PST-P-2.
export const PACKAGE = '@postroom/auth-checks';

export * from './arc/index.js';
export * from './dkim/index.js';
export * from './dmarc/index.js';
export * from './psl/index.js';
export * from './spf/index.js';
