import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DataList,
  DataListRow,
  EmptyState,
  FilterBar,
  FormField,
  Input,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  SearchField,
  Stack,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, api, describeError, type Suppression } from '../api';
import { RelativeTime } from '../components/RelativeTime';
import { PHONE_QUERY, useMediaQuery } from '../mail/useMedia';
import { Loading, LoadFailed } from './states';
import '../admin/admin.css';
import '../admin/lists.css';

/** Why an address is listed, in plain words (critique 2.8 #3: plain text, never a pill). */
export const whyOf = (s: Pick<Suppression, 'reason'>): string => (s.reason === 'manual' ? 'Added by an admin' : 'Hard bounce');

/** "1 address", "12 addresses": the toolbar's count. */
export const addressCount = (n: number): string => `${String(n)} ${n === 1 ? 'address' : 'addresses'}`;

/** Show the "Bounced message" column only when some row has one (critique 2.8 #4): never a column of dashes. */
export const hasBouncedMessage = (rows: readonly Pick<Suppression, 'source'>[]): boolean => rows.some((s) => s.source !== null);

/** The remote reply that listed it, as the wire said it: `550 5.1.1 No such user`. */
export function replyOf(s: Suppression): string {
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
  const phone = useMediaQuery(PHONE_QUERY);

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

  // One action, so one secondary button — never red in the row; the step-up modal says "remove" in red.
  const removeButton = (s: Suppression) => (
    <Button
      size="sm"
      variant="secondary"
      aria-label={`Remove ${s.address}`}
      onClick={() => {
        open({ kind: 'remove', entry: s });
      }}
    >
      Remove
    </Button>
  );

  const reply = (s: Suppression) => (
    <span className={s.reason === 'manual' ? 'pr-clip' : 'pr-mono pr-muted pr-clip'} title={replyOf(s)}>
      {replyOf(s)}
    </span>
  );

  const columns: TableColumn<Suppression>[] = [
    { key: 'address', header: 'Address', width: 'auto', cell: (s) => <span className="pr-mono pr-clip" title={s.address}>{s.address}</span> },
    // D-016: a listed address is the list doing its job, not something that needs you — so no hue, and no pill.
    { key: 'reason', header: 'Why', width: '9rem', cell: (s) => <span className="pr-muted">{whyOf(s)}</span> },
    { key: 'reply', header: 'Bounce or note', width: 'auto', cell: reply },
    ...(rows !== null && hasBouncedMessage(rows)
      ? [
          {
            key: 'subject',
            header: 'Bounced message',
            width: '20%',
            cell: (s: Suppression) =>
              s.source === null ? <span className="pr-muted">—</span> : <span className="pr-clip">{s.source.subject ?? '(no subject)'}</span>,
          } satisfies TableColumn<Suppression>,
        ]
      : []),
    { key: 'bounceCount', header: 'Bounces', width: '6rem', numeric: true, cell: (s) => String(s.bounceCount) },
    { key: 'lastAt', header: 'Last', width: '8rem', cell: (s) => <RelativeTime iso={s.lastAt} /> },
    { key: 'actions', header: <span className="pr-sr-only">Actions</span>, width: '7rem', align: 'end', cell: removeButton },
  ];

  const title = pending === null ? 'Confirm' : pending.kind === 'add' ? 'Add an address to the suppression list' : `Remove ${pending.entry.address}`;

  const empty = (
    <EmptyState
      kind={query === '' ? 'empty' : 'no-results'}
      heading={query === '' ? 'No suppressed addresses' : 'No address matches'}
      headingLevel={2}
      size={phone ? 'inline' : 'row'}
    >
      {query === '' ? 'An address is added here when mail to it bounces because it does not exist.' : 'Try part of the address instead.'}
    </EmptyState>
  );

  return (
    <Page>
      <PageHeader
        title="Suppressions"
        description="Addresses that hard-bounced or were added by hand. Mail to them is refused from every sending path until they are removed."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              open({ kind: 'add' });
            }}
          >
            Add address
          </Button>
        }
      />

      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      <Card className="pr-table-card">
        <div className="pr-table-toolbar">
          <FilterBar aria-label="Filter the suppression list" trailing={rows === null ? null : <span>{addressCount(total)}</span>}>
            <SearchField
              aria-label="Search addresses"
              placeholder="Search addresses"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value.trim());
              }}
            />
          </FilterBar>
        </div>
        {loadError !== null ? (
          <LoadFailed error={loadError} what="the suppression list" onRetry={() => void load(query)} />
        ) : rows === null ? (
          <Loading label="Loading the suppression list" />
        ) : phone ? (
          <DataList aria-label="Suppression list" empty={empty}>
            {rows.map((s) => (
              <DataListRow
                key={s.id}
                title={<span className="pr-mono">{s.address}</span>}
                truncate={false}
                description={
                  <span className="pr-list-desc">
                    {whyOf(s)} · {replyOf(s)} · <RelativeTime iso={s.lastAt} />
                  </span>
                }
                actions={removeButton(s)}
              />
            ))}
          </DataList>
        ) : (
          <Table
            className="pr-admin-table pr-admin-table--fixed"
            caption="Suppression list"
            captionHidden
            columns={columns}
            rows={rows}
            rowKey={(s) => s.id}
            empty={empty}
          />
        )}
      </Card>

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
                <Input appearance="filled"
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
              <Input appearance="filled"
                required
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                }}
              />
            </FormField>
            <FormField label="Authentication code" {...(codeError === null ? {} : { error: codeError })}>
              <Input appearance="filled"
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
