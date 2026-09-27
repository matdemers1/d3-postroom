import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Cluster,
  EmptyState,
  FormField,
  Input,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  Stack,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, api, describeError, type Suppression } from '../api';
import { Loading, LoadFailed } from './states';

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The remote reply that listed it, as the wire said it: `550 5.1.1 No such user`. */
function replyOf(s: Suppression): string {
  if (s.reason === 'manual') return s.note ?? '—';
  return [s.code === null ? null : String(s.code), s.enhanced, s.text].filter((p): p is string => p !== null && p !== '').join(' ') || '—';
}

type Pending = { kind: 'add' } | { kind: 'remove'; entry: Suppression };

/**
 * PST-T-11.10 / PST-REQ-178: the suppression list — addresses a delivery attempt proved do not
 * exist (a 5.1.x hard bounce, PST-REQ-176), plus any an admin added. While an address is listed
 * every sending path refuses mail to it (PST-REQ-179). Adding and removing need a fresh step-up
 * (PST-REQ-008), and ask for a reason, which the audit entry records (PST-REQ-181).
 */
export function AdminSuppressions() {
  const [rows, setRows] = useState<Suppression[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const [pending, setPending] = useState<Pending | null>(null);
  const [address, setAddress] = useState('');
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (q: string) => {
    try {
      const result = await api.suppressions(q === '' ? {} : { q });
      setRows(result.suppressions);
      setTotal(result.total);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load(query);
  }, [load, query]);

  const open = (next: Pending): void => {
    setNotice(null);
    setAddress('');
    setReason('');
    setCode('');
    setFormError(null);
    setCodeError(null);
    setPending(next);
  };

  const confirm = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (pending === null) return;
    setBusy(true);
    setFormError(null);
    setCodeError(null);
    try {
      await api.stepUp(code);
      if (pending.kind === 'add') {
        const added = await api.addSuppression(address, reason);
        setNotice(`${added.address} is on the suppression list. Mail to it will be refused until it is removed.`);
      } else {
        await api.removeSuppression(pending.entry.id, reason);
        setNotice(`${pending.entry.address} is off the suppression list. Mail to it will be sent again.`);
      }
      setPending(null);
      await load(query);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'invalid_code') {
        setCode('');
        setCodeError('That code was not accepted.');
        return;
      }
      if (caught instanceof ApiError && caught.code === 'already_suppressed') {
        setFormError('That address is already on the list.');
        return;
      }
      if (caught instanceof ApiError && caught.code === 'invalid_request' && pending.kind === 'add') {
        setFormError('Enter a whole address, like name@example.com, and a reason.');
        return;
      }
      setPending(null);
      setNotice(caught instanceof ApiError && caught.code === 'not_found' ? 'That address was already removed.' : describeError(caught));
      await load(query);
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumn<Suppression>[] = [
    { key: 'address', header: 'Address', cell: (s) => s.address },
    {
      key: 'reason',
      header: 'Why',
      cell: (s) => (s.reason === 'manual' ? <Badge tone="neutral">Added by an admin</Badge> : <Badge tone="danger">Hard bounce</Badge>),
    },
    { key: 'reply', header: 'Bounce or note', cell: replyOf },
    { key: 'subject', header: 'Bounced message', cell: (s) => (s.source === null ? '—' : (s.source.subject ?? '(no subject)')) },
    { key: 'bounceCount', header: 'Bounces', align: 'end', cell: (s) => String(s.bounceCount) },
    { key: 'lastAt', header: 'Last', cell: (s) => when(s.lastAt) },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (s) => (
        <Button size="sm" variant="danger-ghost" aria-label={`Remove ${s.address}`} onClick={() => { open({ kind: 'remove', entry: s }); }}>
          Remove
        </Button>
      ),
    },
  ];

  const title = pending === null ? 'Confirm' : pending.kind === 'add' ? 'Add an address to the suppression list' : `Remove ${pending.entry.address}`;

  return (
    <Page>
      <PageHeader
        title="Suppression list"
        description="Addresses that hard-bounced or were added by hand. Mail to them is refused from every sending path until they are removed."
        {...(rows === null ? {} : { count: total, countNoun: { one: 'address', other: 'addresses' } })}
        actions={
          <Button variant="primary" onClick={() => { open({ kind: 'add' }); }}>
            Add address
          </Button>
        }
      />
      <Cluster gap="12">
        <FormField label="Search" width="sm">
          <Input
            type="search"
            value={query}
            placeholder="name@example.com"
            onChange={(e) => {
              setQuery(e.target.value.trim());
            }}
          />
        </FormField>
      </Cluster>

      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      {loadError !== null ? (
        <LoadFailed error={loadError} what="the suppression list" onRetry={() => void load(query)} />
      ) : rows === null ? (
        <Loading label="Loading the suppression list" />
      ) : (
        <Table
          caption="Suppression list"
          captionHidden
          columns={columns}
          rows={rows}
          rowKey={(s) => s.id}
          empty={
            <EmptyState kind={query === '' ? 'empty' : 'no-results'} heading={query === '' ? 'No suppressed addresses' : 'No address matches'} size="row">
              {query === '' ? 'An address is added here when mail to it bounces because it does not exist.' : 'Try part of the address instead.'}
            </EmptyState>
          }
        />
      )}

      <Modal
        open={pending !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setPending(null);
        }}
        title={title}
        description={
          pending?.kind === 'remove'
            ? 'Mail to this address will be accepted and sent again. Enter a code from your authenticator; it stays valid for five minutes.'
            : 'Mail to this address will be refused until it is removed. Enter a code from your authenticator; it stays valid for five minutes.'
        }
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="submit" form="suppression-confirm" variant={pending?.kind === 'remove' ? 'danger' : 'primary'} loading={busy}>
              {pending?.kind === 'remove' ? 'Verify and remove' : 'Verify and add'}
            </Button>
          </>
        }
      >
        <form id="suppression-confirm" onSubmit={(e) => { void confirm(e); }}>
          <Stack gap="12">
            {formError === null ? null : (
              <Alert tone="danger" dynamic>
                {formError}
              </Alert>
            )}
            {pending?.kind === 'add' ? (
              <FormField label="Address">
                <Input
                  type="email"
                  required
                  autoFocus
                  value={address}
                  placeholder="name@example.com"
                  onChange={(e) => {
                    setAddress(e.target.value);
                  }}
                />
              </FormField>
            ) : null}
            <FormField label="Reason" help="Recorded on the audit entry.">
              <Input
                required
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                }}
              />
            </FormField>
            <FormField label="Authentication code" {...(codeError === null ? {} : { error: codeError })}>
              <Input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*"
                required
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                }}
              />
            </FormField>
          </Stack>
        </form>
      </Modal>
    </Page>
  );
}
