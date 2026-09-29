// PST-T-14.9 (IA-09, IA-I5, MOD-I8): one Person card, opened from the sender's name in a message
// header — a popover on a desktop, a sheet on a phone. It merges what used to be two objects on two
// screens (the Sender profile and the Contact): who they are, whether they are in your contacts (Add
// to contacts), where their mail goes — a control, not a fact (the sender pin, audited) — their three
// most recent messages, Unsubscribe for a newsletter, and "Open full profile" for the depth
// (authentication rates, the full history), which stays one click away and never in the card.
import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Avatar, Button, Select } from '@d3cloud/ui';
import { api, contactPath, contactsApi, describeError, senderProfilePath, type SenderProfile } from '../../api';
import { listDate } from '../format';
import { mailPath } from '../route';
import { SPLIT_QUERY, useMediaQuery } from '../useMedia';
import { sortingApi } from './api';
import { Floating } from './Floating';
import { BUCKET_LABEL, bucketLabel, FILING_BUCKETS, isFilingBucket, routingHelp, type FilingBucket } from './sorting';

/** The routing Select's value for "no pin: sorted automatically". */
const AUTO = 'auto';

type ContactHit = { addressBookId: string; name: string; displayName: string } | null;

export interface PersonCardProps {
  address: string;
  name: string;
  /** The bucket of the message the card was opened from (says why they are where they are). */
  bucket: string | null;
  anchor: DOMRect;
  returnFocus: HTMLElement | null;
  opener?: HTMLElement | null;
  onClose: () => void;
}

export function PersonCard({ address, name, bucket, anchor, returnFocus, opener = null, onClose }: PersonCardProps) {
  const wide = useMediaQuery(SPLIT_QUERY);
  const [profile, setProfile] = useState<SenderProfile | null>(null);
  const [contact, setContact] = useState<ContactHit | undefined>(undefined);
  /** Every address the person has: this one first, then the others on their contact card. */
  const [addresses, setAddresses] = useState<string[]>([address]);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<'contact' | 'route' | 'unsubscribe' | null>(null);

  useEffect(() => {
    let live = true;
    api.senderProfile(address).then(
      (p) => {
        if (live) setProfile(p);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    contactsApi.lookup(address).then(
      (r) => {
        if (!live) return;
        setContact(r.contact);
        if (r.contact === null) return;
        contactsApi.get(r.contact.addressBookId, r.contact.name).then(
          (card) => {
            if (live) setAddresses([address, ...card.emails.map((e) => e.address).filter((a) => a.toLowerCase() !== address.toLowerCase())]);
          },
          () => undefined,
        );
      },
      () => {
        if (live) setContact(null);
      },
    );
    return () => {
      live = false;
    };
  }, [address]);

  const addContact = async () => {
    setBusy('contact');
    setStatus(null);
    try {
      const books = (await contactsApi.addressBooks()).addressBooks;
      const book = books[0];
      if (book === undefined) throw new Error('You have no address book yet.');
      const display = name.trim() === '' || name === address ? '' : name.trim();
      const saved = await contactsApi.create(book.id, { fn: display === '' ? address : display, given: '', family: '', emails: [{ address, type: null }], tels: [], org: '', note: '' });
      setContact({ addressBookId: saved.addressBookId, name: saved.name, displayName: display === '' ? address : display });
      setStatus('Added to your contacts.');
    } catch (error) {
      setStatus(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const route = async (value: string) => {
    if (profile === null) return;
    setBusy('route');
    setStatus(null);
    try {
      if (isFilingBucket(value)) await sortingApi.setPin(address, value);
      else await sortingApi.clearPin(address);
      setProfile({ ...profile, pin: isFilingBucket(value) ? value : null });
      setStatus(isFilingBucket(value) ? `New mail from ${name} goes to ${BUCKET_LABEL[value]}.` : `${name}'s mail is sorted automatically again.`);
    } catch (error) {
      setStatus(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const newsletterMessage = profile?.recentMessages.find((m) => m.bucket === 'newsletters') ?? null;
  const isNewsletter = bucket === 'newsletters' || profile?.pin === 'newsletters' || newsletterMessage !== null;
  const unsubscribe = async () => {
    const target = newsletterMessage ?? profile?.recentMessages[0] ?? null;
    if (target === null) return;
    setBusy('unsubscribe');
    setStatus(null);
    try {
      const r = await api.unsubscribe(target.id);
      setStatus(!r.offered ? (r.mailto !== null ? `They only offer a mailto: unsubscribe (${r.mailto}); Postroom never sends that for you.` : 'Their mail does not offer one-click unsubscribe.') : r.ok ? 'Unsubscribe request sent.' : `Unsubscribe failed: ${r.detail}`);
      setProfile(await api.senderProfile(address));
    } catch (error) {
      setStatus(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const title = name.trim() === '' ? address : name;
  const selectId = `pr-person-route-${address.replace(/[^a-z0-9]/gi, '-')}`;

  return (
    <Floating anchor={anchor} returnFocus={returnFocus} opener={opener} label={title} sheet={!wide} onClose={onClose} className="pr-person" testId="person-card">
      <div className="pr-person__head">
        <Avatar name={title} size="lg" />
        <div className="pr-person__who">
          <p className="pr-person__name">{title}</p>
          {addresses.map((a) => (
            <p key={a} className="pr-person__addr">
              {a}
            </p>
          ))}
        </div>
      </div>

      <div className="pr-person__row" data-testid="person-contact">
        {contact === undefined ? (
          <span className="pr-person__muted">Checking your contacts…</span>
        ) : contact === null ? (
          <>
            <span className="pr-person__muted">Not in your contacts</span>
            <Button size="sm" variant="secondary" loading={busy === 'contact'} onClick={() => void addContact()}>
              Add to contacts
            </Button>
          </>
        ) : (
          <>
            <span>In your contacts</span>
            <RouterLink className="pr-person__link" to={contactPath(contact.addressBookId, contact.name)} onClick={onClose}>
              Edit<span className="pr-vh"> {contact.displayName} in Contacts</span>
            </RouterLink>
          </>
        )}
      </div>

      {failed ? (
        <p className="pr-person__muted">This sender’s history could not be loaded.</p>
      ) : profile === null ? (
        <p className="pr-person__muted">Loading…</p>
      ) : (
        <>
          <div className="pr-person__section">
            <label className="pr-person__label" htmlFor={selectId}>
              Their mail goes to
            </label>
            {/* The design-system Select (PST-T-14.11). Its items cannot carry an empty value, so
                "sorted automatically" is the AUTO sentinel here and no pin at the API. */}
            <Select
              appearance="filled"
              id={selectId}
              className="pr-person__select"
              value={profile.pin ?? AUTO}
              disabled={busy === 'route'}
              onValueChange={(v) => void route(v === AUTO ? '' : v)}
              options={[
                { value: AUTO, label: `Sorted automatically${isFilingBucket(bucket) ? ` (${bucketLabel(bucket)})` : ''}` },
                ...FILING_BUCKETS.map((b: FilingBucket) => ({ value: b, label: BUCKET_LABEL[b] })),
              ]}
            />
            <p className="pr-person__help">{routingHelp(profile.pin, bucket, title)}</p>
          </div>

          {isNewsletter ? (
            <div className="pr-person__row">
              <span className="pr-person__muted">
                {profile.unsubscribe.attempted && profile.unsubscribe.result === 'sent' && profile.unsubscribe.at !== null ? `Unsubscribed ${listDate(profile.unsubscribe.at)}` : 'A newsletter'}
              </span>
              <Button size="sm" variant="secondary" loading={busy === 'unsubscribe'} onClick={() => void unsubscribe()}>
                Unsubscribe
              </Button>
            </div>
          ) : null}

          <div className="pr-person__section">
            <p className="pr-person__label">Recent</p>
            {profile.recentMessages.length === 0 ? (
              <p className="pr-person__muted">No messages from them yet.</p>
            ) : (
              <ul className="pr-person__recent">
                {profile.recentMessages.slice(0, 3).map((m) => (
                  <li key={m.id}>
                    <RouterLink className="pr-person__msg" to={mailPath(m.mailboxId ?? null, m.id)} onClick={onClose}>
                      <span className="pr-person__subject">{m.subject === null || m.subject === '' ? '(no subject)' : m.subject}</span>
                      <time dateTime={m.date}>{listDate(m.date)}</time>
                    </RouterLink>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <p className="pr-person__status" role="status" aria-live="polite">
        {status}
      </p>

      <div className="pr-person__foot">
        <span className="pr-person__muted">
          {profile === null ? null : `${String(profile.messageCount)} ${profile.messageCount === 1 ? 'message' : 'messages'}`}
        </span>
        <RouterLink className="pr-person__link" to={senderProfilePath(address)} onClick={onClose}>
          Open full profile <span aria-hidden="true">›</span>
        </RouterLink>
      </div>
    </Floating>
  );
}
