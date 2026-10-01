// Addresses (PST-T-17.10, PST-REQ-112): what a masked alias row says — its status as a word for a
// StatusDot, the facts on its description line, and its row menu. Pure, so the unit tests read them
// without a DOM.
import type { Alias } from '../api';

export interface AliasStatus {
  label: 'Live' | 'Off';
  /** Live is the healthy state, so neutral (D-016); Off was the person's own choice, so idle. */
  tone: 'neutral' | 'idle';
}

export function aliasStatus(alias: Pick<Alias, 'killedAt'>): AliasStatus {
  return alias.killedAt === null ? { label: 'Live', tone: 'neutral' } : { label: 'Off', tone: 'idle' };
}

/** "For shop.example · 3 received" — the last-used time follows it, drawn by RelativeTime. */
export function aliasFacts(alias: Pick<Alias, 'site' | 'receivedCount'>): string {
  return `For ${alias.site} · ${String(alias.receivedCount)} received`;
}

export type AliasAction = 'copy' | 'turn-off' | 'turn-on';

/** The row's ⋯ menu: Copy address, then Turn off or Turn on — reversible, so never red. */
export function aliasActions(alias: Pick<Alias, 'killedAt'>): { action: AliasAction; label: string }[] {
  return [{ action: 'copy', label: 'Copy address' }, alias.killedAt === null ? { action: 'turn-off', label: 'Turn off' } : { action: 'turn-on', label: 'Turn on' }];
}
