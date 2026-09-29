// One message's header on one line (PST-T-14.6; design audit VIS-07, MOD-I4): avatar, the sender's
// name, "to me, Jonah Reyes ▾" — which opens the full address block in place — and the relative
// date, with the absolute one in a tooltip on hover and focus. The From/To/Cc/Date table, and the
// "Sender profile" and "In contacts as …" links, live in that block rather than in the calm view.
//
// The block opens with height + opacity over --dur-2 (PST-REQ-192) via a grid-rows transition, so
// no script measures anything; under prefers-reduced-motion the library zeroes the duration
// (PST-REQ-193).
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Avatar, Tooltip } from '@d3cloud/ui';
import { contactPath, contactsApi, type MessageBody, type MessageDetail } from '../../api';
import { fullDate, header } from '../format';
import { useMail } from '../MailContext';
import { CaretIcon } from './icons';
import { absoluteDate, recipientSummary, relativeDate, senderName } from './view';

export function MessageHeader({ detail, body, extra }: { detail: MessageDetail; body: MessageBody | null; extra?: ReactNode }) {
  const { me } = useMail();
  const [open, setOpen] = useState(false);
  const blockId = useId();
  const from = header(body, 'From') ?? detail.from ?? '';
  const to = header(body, 'To');
  const cc = header(body, 'Cc');
  const name = senderName(from);
  const summary = recipientSummary(to, cc, me) ?? 'Show details';

  return (
    <div className="pr-mhead" data-testid="message-header">
      <div className="pr-mhead__line">
        <Avatar name={name} size="md" />
        <span className="pr-mhead__who">
          <span className="pr-mhead__name" data-testid="message-from">
            {name}
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
      </div>
      <div className="pr-reveal" data-open={open} id={blockId}>
        <div className="pr-reveal__inner" inert={!open}>
          <AddressBlock detail={detail} from={from} to={to} cc={cc} />
        </div>
      </div>
    </div>
  );
}

/** The full address block: who exactly, and the links that used to crowd the calm view. */
function AddressBlock({ detail, from, to, cc }: { detail: MessageDetail; from: string; to: string | null; cc: string | null }) {
  // PST-REQ-137: a sender who is in the address book links to their card.
  const [contact, setContact] = useState<{ addressBookId: string; name: string; displayName: string } | null>(null);
  useEffect(() => {
    setContact(null);
    const address = detail.from;
    if (address === null || address === '') return undefined;
    let live = true;
    contactsApi
      .lookup(address)
      .then((r) => {
        if (live) setContact(r.contact);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [detail.from]);
  return (
    <dl className="pr-mhead__block">
      <dt>From</dt>
      <dd>
        {from === '' ? '(unknown sender)' : from}
        {detail.from === null || detail.from === '' ? null : (
          <>
            {' · '}
            <RouterLink to={`/senders/${encodeURIComponent(detail.from)}`}>Sender profile</RouterLink>
          </>
        )}
        {contact === null ? null : (
          <>
            {' · '}
            <RouterLink to={contactPath(contact.addressBookId, contact.name)}>In contacts as {contact.displayName}</RouterLink>
          </>
        )}
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
