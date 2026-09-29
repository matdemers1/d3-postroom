// The two faces of a sent message's delivery (PST-T-14.1, design audit CPY-01; PST-REQ-119).
//
// DeliveryRecipientRow is the calm reading view: the address and one plain-language line —
// "Delivered", "Retrying at 3:40 PM", "Bounced — address doesn't exist" — built by delivery.ts's
// deliveryLine, which never echoes the remote server's text. DeliveryEvidence is the Inspect
// drawer's: every attempt with its transport, host, TLS and the raw SMTP reply. Nothing in the first
// renders a reply code or reply text; that is what keeps a raw "550 5.1.10 …" (or any string a test
// transport wrote) out of the calm view.
import { Badge } from '@d3cloud/ui';
import type { DeliveryRecipient } from '../api';
import { attemptRemoteText, attemptSummary, deferralReason, deliveryLine, dsnFiledAt, relativeMinutes, STATE_LABEL, STATE_TONE } from './delivery';
import { fullDate } from './format';
import { DangerIcon, WarningIcon } from './icons';
import { deliveryChipTone, deliverySentence } from './thread/view';

/** One recipient in the reading view: who, and what happened, in words. A deferral or a bounce is an
 *  exception, so it reads as a chip (PST-T-14.6) followed by one plain sentence; anything else is a
 *  quiet line. */
export function DeliveryRecipientRow({ recipient: r, now }: { recipient: DeliveryRecipient; now?: Date }) {
  const dsnAt = dsnFiledAt(r);
  const at = now ?? new Date();
  const chip = deliveryChipTone(r.state);
  const sentence = deliverySentence(r);
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
