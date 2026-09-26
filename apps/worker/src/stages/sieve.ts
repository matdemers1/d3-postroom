// Stage 4, sieve — a no-op until Sieve lands (PST-P-6). It still
// records that it ran and why it did nothing, so a message's history never has a silent gap.
import type { SieveResult } from './types.js';

export function sieveStage(): SieveResult {
  return { applied: false, reasons: ['no sieve script (Sieve arrives in PST-P-6)'] };
}
