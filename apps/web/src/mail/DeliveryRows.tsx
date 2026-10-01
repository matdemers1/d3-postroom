// The two faces of a sent message's delivery (PST-T-14.1, design audit CPY-01; PST-REQ-119).
//
// DeliveryRecipientRow is the calm reading view: the address and one plain-language line —
// "Delivered", "Retrying at 3:40 PM", "Bounced — address doesn't exist" — built by delivery.ts's
// deliveryLine, which never echoes the remote server's text. DeliveryEvidence is the Inspect
// drawer's: every attempt with its transport, host, TLS and the raw SMTP reply. Nothing in the first
// renders a reply code or reply text; that is what keeps a raw "550 5.1.10 …" (or any string a test
// transport wrote) out of the calm view.
import { Link as RouterLink } from 'react-router-dom';
import { Badge, Button, Skeleton } from '@d3cloud/ui';
import type { DeliveryRecipient } from '../api';
import { attemptRemoteText, attemptSummary, deferralReason, deliveryLine, dsnFiledAt, relativeMinutes, STATE_LABEL, STATE_TONE, type CancelledFields } from './delivery';
import { fullDate } from './format';
import { DangerIcon, WarningIcon } from './icons';
import { canResend } from './resend';
import { deliveryChipTone, deliverySentence } from './thread/view';

/** The delivery section while it is being looked up: one quiet line the height of the first real one,
 *  so nothing below it jumps when the recipients arrive (PST-T-16.14). */
export function DeliverySkeleton() {
  return (
    <section aria-label="Delivery" aria-busy="true" className="pr-delivery" data-testid="delivery-loading">
      <Skeleton variant="text" lines={1} />
    </section>
  );
}

/** One recipient in the reading view: who, and what happened, in words. A deferral or a bounce is an
 *  exception, so it reads as a chip (PST-T-14.6) followed by one plain sentence; anything else is a
 *  quiet line — a cancelled one adds why and when (PST-T-16.14). A bounced or cancelled recipient
 *  offers "Edit and resend", and an admin gets a link to the recipient's row in the outbound queue. */
export function DeliveryRecipientRow({
  recipient: r,
  now,
  onResend,
  resending = false,
  queueTo,
}: {
  recipient: DeliveryRecipient & CancelledFields;
  now?: Date;
  /** Opens the composer with a draft of this message for the failed recipient(s); absent: no button. */
  onResend?: (recipient: DeliveryRecipient) => void;
  resending?: boolean;
  /** Admins only: the queue, filtered to this message (resend.ts's queuePath). */
  queueTo?: string | null;
}) {
  const dsnAt = dsnFiledAt(r);
  const at = now ?? new Date();
  const chip = deliveryChipTone(r.state);
  const sentence = deliverySentence(r, at);
  const line = (
    <>
      {deliveryLine(r, at)}
      {r.state === 'deferred' ? <span className="pr-delivery__when"> ({relativeMinutes(r.nextAttemptAt, at)})</span> : null}
    </>
  );
  return (
    <li className="pr-delivery__recipient" data-testid="delivery-recipient" data-state={r.state} data-exception={chip !== null}>
      <span className="pr-delivery__address">{r.address}</span>
      <p className="pr-delivery__state" data-testid="delivery-state" data-tone={STATE_TONE[r.state]}>
        {chip === null ? (
          line
        ) : (
          <span className="pr-chip pr-chip--line" data-tone={chip}>
            <span className="pr-chip__icon" aria-hidden="true">
              {chip === 'danger' ? <DangerIcon /> : <WarningIcon />}
            </span>
            {line}
          </span>
        )}
      </p>
      {sentence !== null ? <p className="pr-exception__sentence">{sentence}</p> : null}
      {r.state === 'bounced' && dsnAt !== null ? (
        <p className="pr-reader__note" data-testid="dsn-note">
          A delivery failure notice was filed to your Inbox at {fullDate(dsnAt)}.
        </p>
      ) : null}
      {(canResend(r.state) && onResend !== undefined) || (queueTo !== undefined && queueTo !== null) ? (
        <div className="pr-delivery__head">
          {canResend(r.state) && onResend !== undefined ? (
            <Button
              size="sm"
              variant="ghost"
              loading={resending}
              aria-label={`Edit and resend to ${r.address}`}
              onClick={() => {
                onResend(r);
              }}
            >
              Edit and resend
            </Button>
          ) : null}
          {queueTo !== undefined && queueTo !== null ? (
            <RouterLink to={queueTo} aria-label={`View ${r.address} in the outbound queue`} data-testid="delivery-queue-link">
              View in queue
            </RouterLink>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Every recipient's attempt log with the remote server's own replies — the Inspect drawer only. */
export function DeliveryEvidence({ recipients }: { recipients: readonly DeliveryRecipient[] }) {
  return (
    <section className="pr-inspect__section" aria-labelledby="pr-inspect-delivery" data-testid="inspect-delivery">
      <h3 id="pr-inspect-delivery" className="pr-inspect__h3">
        Delivery attempts
      </h3>
      <ul className="pr-delivery__list">
        {recipients.map((r) => {
          const reason = deferralReason(r);
          return (
            <li key={r.id} className="pr-delivery__recipient" data-testid="inspect-delivery-recipient" data-state={r.state}>
              <div className="pr-delivery__head">
                <Badge tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</Badge>
                <span className="pr-delivery__address">{r.address}</span>
              </div>
              {reason !== null ? (
                <p className="pr-reader__note" data-testid="deferral-reason">
                  {reason}
                </p>
              ) : null}
              {r.state === 'deferred' ? (
                <p className="pr-reader__note" data-testid="next-retry">
                  Next retry at {fullDate(r.nextAttemptAt)} ({relativeMinutes(r.nextAttemptAt)}).
                </p>
              ) : null}
              {r.attemptsLog.length > 0 ? (
                <ol className="pr-delivery__attempts" aria-label={`Attempts for ${r.address}`}>
                  {r.attemptsLog.map((a) => {
                    const remote = attemptRemoteText(a);
                    return (
                      <li key={a.startedAt}>
                        <span>
                          {fullDate(a.startedAt)} · {attemptSummary(a)}
                        </span>
                        {remote !== null ? <span className="pr-reader__note"> — {remote}</span> : null}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="pr-reader__note">No attempts yet.</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
