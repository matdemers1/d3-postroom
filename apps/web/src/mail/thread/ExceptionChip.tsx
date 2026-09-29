// Exception chips (PST-T-14.6; design audit CPY-01, CPY-02, VIS-07). A chip appears only when
// something is wrong — a spoofed or unverified sender, a deferred or bounced delivery — followed by
// one plain sentence and "Details". There is no positive "Verified" chip: a lookalike domain passes
// its own DMARC, so a tick would vouch for exactly the mail it should warn about. Normal is silent.
//
// The phishing chip replaces the verdict paragraph and the stack of DMARC/SPF callouts. Every
// warning's own reason is still shown (PST-REQ-120: the reason, never just the kind), worst first; a
// `high` one interrupts as role="alert", the rest sit quietly inside the same labelled region.
import type { ReactNode } from 'react';
import { Badge, Button } from '@d3cloud/ui';
import type { Phish } from '../../api';
import { DangerIcon, WarningIcon } from '../icons';
import { sortPhishWarnings } from '../phish';
import { phishAdvice, phishChip, phishLead, type ChipTone } from './view';

/** The chip itself: a tone icon (severity never rests on colour alone) and the words. */
export function ExceptionChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <Badge tone={tone} className="pr-chip" data-tone={tone}>
      <span className="pr-chip__icon" aria-hidden="true">
        {tone === 'danger' ? <DangerIcon /> : <WarningIcon />}
      </span>
      {children}
    </Badge>
  );
}

export function PhishChip({
  phish,
  inJunk,
  onMoveToJunk,
  onDetails,
  from,
}: {
  phish: Phish | null;
  /** The sender's address, for the plain sentence. */
  from: string | null;
  inJunk: boolean;
  onMoveToJunk: (() => void) | undefined;
  /** Opens Inspect for this message; absent when this message is not the one the drawer belongs to. */
  onDetails: (() => void) | undefined;
}) {
  if (phish === null || phish.warnings.length === 0) return null;
  const sorted = sortPhishWarnings(phish.warnings);
  const chip = phishChip(sorted);
  if (chip === null) return null;
  return (
    <section aria-label="Phishing and authentication warnings" className="pr-exception" data-testid="phish-warnings" data-tone={chip.tone}>
      <div className="pr-exception__head">
        <ExceptionChip tone={chip.tone}>{chip.label}</ExceptionChip>
      </div>
      {/* A `high` warning interrupts (role="alert"); the sentence says it plainly and each check's
          own reason follows, worst first, as quieter evidence. */}
      <div className="pr-exception__text" role={chip.tone === 'danger' ? 'alert' : undefined}>
        <p className="pr-exception__sentence">
          {phishLead(sorted, from)} {phishAdvice(sorted)}
        </p>
        <ul className="pr-exception__reasons">
          {sorted.map((w, index) => (
            <li key={`${w.kind}-${String(index)}`} data-testid="phish-warning" data-phish-kind={w.kind} data-phish-severity={w.severity}>
              {w.reason}
            </li>
          ))}
        </ul>
      </div>
      <div className="pr-exception__actions">
        {onDetails !== undefined ? (
          <Button size="sm" variant="ghost" aria-label="Details: inspect this message" onClick={onDetails}>
            Details
          </Button>
        ) : null}
        {onMoveToJunk !== undefined && !inJunk ? (
          <Button size="sm" variant="secondary" onClick={onMoveToJunk}>
            Move to Junk
          </Button>
        ) : null}
      </div>
    </section>
  );
}
