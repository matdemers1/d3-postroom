// The sender profile (PST-T-5.6, PST-REQ-113): message history, bucket distribution, pin/screen
// state, unsubscribe status, an authentication summary, and the address(es) of ours this sender
// wrote to. Linked from the reading pane's From line and from a Feed item's sender.
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Alert, Badge, Button, DescriptionItem, DescriptionList, EmptyState, Page, PageHeader, Section, Table, type TableColumn } from '@d3cloud/ui';
import { api, contactsApi, describeError, type SenderProfile as SenderProfileJson, type SenderProfileMessage } from '../api';
import { Loading, LoadFailed } from './states';

const when = (iso: string | null): string => (iso === null ? '—' : new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));

const pct = (rate: number | null): string => (rate === null ? '—' : `${String(Math.round(rate * 100))}%`);

const BUCKET_LABEL: Record<string, string> = {
  priority: 'Priority',
  people: 'People',
  newsletters: 'Newsletters',
  updates: 'Updates',
  receipts: 'Receipts',
  notifications: 'Notifications',
  junk: 'Junk',
};

type ContactHit = { addressBookId: string; name: string; displayName: string } | null;

export function SenderProfile() {
  const params = useParams();
  const address = params['address'] ?? '';
  const navigate = useNavigate();
  const [profile, setProfile] = useState<SenderProfileJson | null>(null);
  const [contact, setContact] = useState<ContactHit>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [busyUnsub, setBusyUnsub] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (address === '') return;
    try {
      const [p, c] = await Promise.all([api.senderProfile(address), contactsApi.lookup(address).catch(() => ({ contact: null }))]);
      setProfile(p);
      setContact(c.contact);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  const unsubscribe = async (messageId: string): Promise<void> => {
    setBusyUnsub(messageId);
    setNotice(null);
    try {
      const result = await api.unsubscribe(messageId);
      if (!result.offered) {
        setNotice({ tone: 'info', text: result.mailto !== null ? `This message only offers a mailto: unsubscribe (${result.mailto}) — Postroom does not send that automatically.` : 'This message does not offer one-click unsubscribe.' });
      } else if (result.ok) {
        setNotice({ tone: 'info', text: 'Unsubscribe request sent.' });
      } else {
        setNotice({ tone: 'danger', text: `Unsubscribe failed: ${result.detail}` });
      }
      await load();
    } catch (caught) {
      setNotice({ tone: 'danger', text: describeError(caught) });
    } finally {
      setBusyUnsub(null);
    }
  };

  if (address === '') return <Navigate />;

  if (loadError !== null) {
    return (
      <Page>
        <PageHeader title="Sender" />
        <LoadFailed error={loadError} what="this sender" onRetry={() => void load()} />
      </Page>
    );
  }

  if (profile === null) {
    return (
      <Page>
        <PageHeader title="Sender" />
        <Loading label="Loading this sender" height={240} />
      </Page>
    );
  }

  const columns: TableColumn<SenderProfileMessage>[] = [
    { key: 'subject', header: 'Subject', cell: (m) => m.subject ?? '(no subject)' },
    { key: 'date', header: 'Date', cell: (m) => when(m.date) },
    { key: 'bucket', header: 'Bucket', cell: (m) => (m.bucket === null ? '—' : (BUCKET_LABEL[m.bucket] ?? m.bucket)) },
  ];

  return (
    <Page>
      <PageHeader
        title={profile.address}
        actions={
          <Button size="sm" variant="ghost" onClick={() => { void navigate(-1); }}>
            Back
          </Button>
        }
      />
      {notice !== null ? <Alert tone={notice.tone} title={notice.tone === 'danger' ? 'Unsubscribe failed' : 'Unsubscribe'}>{notice.text}</Alert> : null}

      <Section title="History">
        <DescriptionList>
          <DescriptionItem term="Messages">{profile.messageCount}</DescriptionItem>
          <DescriptionItem term="First seen">{when(profile.firstSeenAt)}</DescriptionItem>
          <DescriptionItem term="Last seen">{when(profile.lastSeenAt)}</DescriptionItem>
          <DescriptionItem term="Buckets">
            {profile.buckets.length === 0
              ? '—'
              : profile.buckets.map((b) => `${BUCKET_LABEL[b.bucket] ?? b.bucket} (${String(b.count)})`).join(', ')}
          </DescriptionItem>
          <DescriptionItem term="Pin">{profile.pin === null ? 'None' : (BUCKET_LABEL[profile.pin] ?? profile.pin)}</DescriptionItem>
          <DescriptionItem term="Screen">{profile.screen === null ? 'None' : profile.screen === 'allow' ? 'Allowed' : 'Blocked'}</DescriptionItem>
          <DescriptionItem term="Wrote to">{profile.wroteTo.length === 0 ? '—' : profile.wroteTo.join(', ')}</DescriptionItem>
          <DescriptionItem term="Contact">{contact === null ? 'Not in your address book' : <RouterLink to={`/contacts/${contact.addressBookId}/${contact.name}`}>{contact.displayName}</RouterLink>}</DescriptionItem>
        </DescriptionList>
      </Section>

      <Section title="Authentication">
        <DescriptionList>
          <DescriptionItem term="DKIM pass rate">{pct(profile.auth.dkimPassRate)}</DescriptionItem>
          <DescriptionItem term="SPF pass rate">{pct(profile.auth.spfPassRate)}</DescriptionItem>
          <DescriptionItem term="DMARC pass rate">{pct(profile.auth.dmarcPassRate)}</DescriptionItem>
          <DescriptionItem term="Signing domains">{profile.auth.dkimDomains.length === 0 ? '—' : profile.auth.dkimDomains.join(', ')}</DescriptionItem>
          <DescriptionItem term="Sample size">{profile.auth.sampleSize} messages</DescriptionItem>
        </DescriptionList>
      </Section>

      <Section title="Unsubscribe">
        <DescriptionList>
          <DescriptionItem term="Status">
            {profile.unsubscribe.attempted ? (
              <Badge tone={profile.unsubscribe.result === 'sent' ? 'neutral' : 'danger'}>{profile.unsubscribe.result === 'sent' ? 'Sent' : 'Failed'}</Badge>
            ) : (
              'Never attempted'
            )}
          </DescriptionItem>
          {profile.unsubscribe.attempted ? (
            <>
              <DescriptionItem term="When">{when(profile.unsubscribe.at)}</DescriptionItem>
              <DescriptionItem term="Detail">{profile.unsubscribe.detail ?? '—'}</DescriptionItem>
            </>
          ) : null}
        </DescriptionList>
        {profile.recentMessages[0] !== undefined ? (
          <Button size="sm" disabled={busyUnsub !== null} onClick={() => { void unsubscribe((profile.recentMessages[0] as SenderProfileMessage).id); }}>
            {busyUnsub !== null ? 'Sending…' : 'Unsubscribe from their latest message'}
          </Button>
        ) : null}
      </Section>

      <Section title="Recent messages">
        {profile.recentMessages.length === 0 ? (
          <EmptyState kind="empty" heading="No messages from this sender yet" size="inline" />
        ) : (
          <Table columns={columns} rows={profile.recentMessages} rowKey={(m) => m.id} caption="Recent messages from this sender" />
        )}
      </Section>
    </Page>
  );
}

function Navigate() {
  return (
    <Page>
      <PageHeader title="Sender" />
      <EmptyState kind="empty" heading="No sender address given" size="inline" />
    </Page>
  );
}
