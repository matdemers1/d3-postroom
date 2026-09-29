// One message's header on one line (PST-T-14.6; design audit VIS-07, MOD-I4): avatar, the sender's
// name, "to me, Jonah Reyes ▾" — which opens the full address block in place — and the relative
// date, with the absolute one in a tooltip on hover and focus. The From/To/Cc/Date table lives in
// that block rather than in the calm view.
//
// PST-T-14.9: the sender's name is a button that opens one Person card (contact + sender profile +
// routing, replacing the block's old "Sender profile" and "In contacts as …" links), and a bucket
// chip shows beside it where the list does not already imply the bucket.
//
// PST-T-15.3 (the redesign canvas): a 36px avatar tinted from the sender's name (Avatar tint="auto",
// the same person the same colour everywhere), the name over "to me, Jonah Reyes ▾", the time, and —
// on the open message — Star and Reply as ghost icon buttons (`actions`).
//
// The block opens with height + opacity over --dur-2 (PST-REQ-192) via a grid-rows transition, so
// no script measures anything; under prefers-reduced-motion the library zeroes the duration
// (PST-REQ-193).
import { useId, useRef, useState, type ReactNode } from 'react';
import { Avatar, Tooltip } from '@d3cloud/ui';
import type { MessageBody, MessageDetail } from '../../api';
import { HeaderBucketChip } from '../sorting/BucketChip';
import { PersonCard } from '../sorting/PersonCard';
import { fullDate, header } from '../format';
import { useMail } from '../MailContext';
import { CaretIcon } from './icons';
import { absoluteDate, recipientSummary, relativeDate, senderName } from './view';

export function MessageHeader({ detail, body, extra, actions }: { detail: MessageDetail; body: MessageBody | null; extra?: ReactNode; actions?: ReactNode }) {
  const { me } = useMail();
  const [open, setOpen] = useState(false);
  const blockId = useId();
  const from = header(body, 'From') ?? detail.from ?? '';
  const to = header(body, 'To');
  const cc = header(body, 'Cc');
  const name = senderName(from);
  const summary = recipientSummary(to, cc, me) ?? 'Show details';
  const nameButton = useRef<HTMLButtonElement>(null);
  const [card, setCard] = useState<DOMRect | null>(null);
  const address = detail.from !== null && detail.from.includes('@') ? detail.from : null;

  return (
    <div className="pr-mhead" data-testid="message-header">
      <div className="pr-mhead__line">
        <Avatar name={name} size="md" tint="auto" className="pr-mhead__avatar" />
        <span className="pr-mhead__who">
          <span className="pr-mhead__nameline">
            {address === null ? (
              <span className="pr-mhead__name" data-testid="message-from">
                {name}
              </span>
            ) : (
              <button
                ref={nameButton}
                type="button"
                className="pr-mhead__name pr-mhead__person"
                data-testid="message-from"
                aria-haspopup="dialog"
                aria-expanded={card !== null}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setCard((c) => (c === null ? rect : null));
                }}
              >
                {name}
              </button>
            )}
            <HeaderBucketChip message={detail} />
          </span>
          <button type="button" className="pr-mhead__to" aria-expanded={open} aria-controls={blockId} onClick={() => { setOpen((v) => !v); }}>
            <span>{summary}</span>
            <span className="pr-mhead__caret" aria-hidden="true">
              <CaretIcon />
            </span>
          </button>
        </span>
        {extra}
        <Tooltip content={absoluteDate(detail.date)}>
          <time className="pr-mhead__date" dateTime={detail.date} tabIndex={0}>
            {relativeDate(detail.date)}
          </time>
        </Tooltip>
        {actions === undefined ? null : <span className="pr-mhead__actions">{actions}</span>}
      </div>
      {card === null || address === null ? null : (
        <PersonCard
          address={address}
          name={name}
          bucket={detail.bucket}
          anchor={card}
          returnFocus={nameButton.current}
          opener={nameButton.current}
          onClose={() => {
            setCard(null);
          }}
        />
      )}
      <div className="pr-reveal" data-open={open} id={blockId}>
        <div className="pr-reveal__inner" inert={!open}>
          <AddressBlock detail={detail} from={from} to={to} cc={cc} />
        </div>
      </div>
    </div>
  );
}

/** The full address block: who exactly. The sender's profile and contact are the Person card now. */
function AddressBlock({ detail, from, to, cc }: { detail: MessageDetail; from: string; to: string | null; cc: string | null }) {
  return (
    <dl className="pr-mhead__block">
      <dt>From</dt>
      <dd>
        {from === '' ? '(unknown sender)' : from}
      </dd>
      {to !== null ? (
        <>
          <dt>To</dt>
          <dd>{to}</dd>
        </>
      ) : null}
      {cc !== null ? (
        <>
          <dt>Cc</dt>
          <dd>{cc}</dd>
        </>
      ) : null}
      <dt>Date</dt>
      <dd>
        <time dateTime={detail.date}>{fullDate(detail.date)}</time>
      </dd>
    </dl>
  );
}
