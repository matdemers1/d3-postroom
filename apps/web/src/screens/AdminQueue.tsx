import { type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  SegmentedControl,
  Stack,
  StatusDot,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, api, describeError, type QueueScope } from '../api';
import { Loading, LoadFailed } from './states';
import { RelativeTime } from '../components/RelativeTime';
import { useUrlText } from '../components/useUrlText';
import { queueState } from '../admin/health/model';
import { DomainActions, QueueActions } from '../admin/queue/QueueActions';
import { QueueDrawer } from '../admin/queue/QueueDrawer';
import {
  filterByMessage,
  parseQueueFilters,
  QUEUE_ACTION_LABEL,
  type QueueActionKind,
  latestOnly,
  loadQueueStates,
  QUEUE_LIST_CAP,
  type QueueRow,
  type QueueStateKey,
  type QueueStateList,
  queueSegmentItems,
  recipientCount,
  withQueueFilter,
} from '../admin/queue/model';
import { PHONE_QUERY, useMediaQuery } from '../mail/useMedia';
import '../admin/admin.css';

type ActionKind = QueueActionKind;
const ACTION_LABEL = QUEUE_ACTION_LABEL;
type Row = QueueRow;

const hidden = (text: string) => <span className="pr-admin-vh">{text}</span>;

/**
 * PST-T-6.6 / PST-REQ-121: the outbound queue admin — retry, bounce, delete and force-SES, per
 * recipient, or across a whole domain. Every mutation needs a fresh step-up (PST-REQ-008): the
 * confirm modal always asks for a current code, since almost every visit to this screen is the
 * first destructive action in the session.
 *
 * PST-T-16.13 (PST-DA-031): the four row actions are one menu, the row's evidence (last reply,
 * every attempt) is a drawer, a phone gets cards, and ?state= ?domain= ?message= hold the filters.
 *
 * PST-T-17.1 (PST-REQ-194/155, admin critique 2.2): the list is a card whose toolbar holds the one
 * Domain search and the State segments with their counts; the domain's bulk actions appear in that
 * toolbar only once a domain is typed, so there is one Domain field on the page.
 */
export function AdminQueue() {
  const [lists, setLists] = useState<Record<QueueStateKey, QueueStateList> | null>(null);
  const latest = useRef(latestOnly());
  const [sesConfigured, setSesConfigured] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [params, setParams] = useSearchParams();
  const { domain, state, message } = parseQueueFilters(params);
  const phone = useMediaQuery(PHONE_QUERY);
  const [details, setDetails] = useState<Row | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [pending, setPending] = useState<{ scope: QueueScope; action: ActionKind; label: string } | null>(null);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Replace, not push: typing a domain letter by letter must not fill the Back stack.
  const setFilter = (key: 'state' | 'domain' | 'message', value: string): void => {
    setParams((current) => withQueueFilter(current, key, value), { replace: true });
  };
  // The domain box's own text, ahead of the URL while a keystroke's navigation is in flight (PST-T-17.18).
  const [domainText, setDomainText] = useUrlText(domain, (value) => {
    setFilter('domain', value);
  });
  // ?message= narrows every state's list to one message's recipients (the counts follow).
  const narrowed = useMemo(() => {
    if (lists === null) return null;
    const out = {} as Record<QueueStateKey, QueueStateList>;
    for (const [key, list] of Object.entries(lists) as [QueueStateKey, QueueStateList][]) {
      const rows = filterByMessage(list.rows, message);
      out[key] = message === '' ? list : { rows, count: rows.length, capped: false };
    }
    return out;
  }, [lists, message]);
  const current = narrowed?.[state] ?? null;
  const shown = current?.rows ?? null;

  // Each state is filtered by the API (loadQueueStates), so a row past the first 500 of All is still
  // under its own state. A domain typed letter by letter fires a load per letter: only the newest
  // answer is kept, so an older, slower one can never replace it.
  const load = useCallback(async (d: string) => {
    const token = latest.current.next();
    try {
      const result = await loadQueueStates((opts) => api.adminQueue(opts), d);
      if (!latest.current.isLatest(token)) return;
      setLists(result.lists);
      setSesConfigured(result.sesConfigured);
      setLoadError(null);
    } catch (caught) {
      if (!latest.current.isLatest(token)) return;
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load(domain);
  }, [load, domain]);

  const runAction = async (scope: QueueScope, action: ActionKind, opts: { code?: string; reason?: string } = {}): Promise<void> => {
    if (opts.code !== undefined && opts.code !== '') await api.stepUp(opts.code);
    switch (action) {
      case 'retry':
        await api.queueRetry(scope);
        break;
      case 'force-ses':
        await api.queueForceSes(scope);
        break;
      case 'bounce':
        await api.queueBounce(scope);
        break;
      case 'delete':
        await api.queueDelete(scope, opts.reason ?? '');
        break;
    }
  };

  const openConfirm = (scope: QueueScope, action: ActionKind, label: string): void => {
    setNotice(null);
    setReason('');
    setCode('');
    setCodeError(null);
    setPending({ scope, action, label });
  };

  const confirm = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (pending === null) return;
    setBusy(true);
    setCodeError(null);
    try {
      await runAction(pending.scope, pending.action, { code, reason });
      setPending(null);
      setNotice(`${pending.label}: done.`);
      await load(domain);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'invalid_code') {
        setCode('');
        setCodeError('That code was not accepted.');
        return;
      }
      setPending(null);
      setNotice(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const pick = (r: Row, kind: ActionKind): void => {
    const who = r.address;
    const label = kind === 'retry' ? `Retry ${who}` : kind === 'force-ses' ? `Force SES for ${who}` : kind === 'bounce' ? `Bounce ${who}` : `Delete ${who}`;
    openConfirm({ kind: 'recipient', id: r.id }, kind, label);
  };

  const stateDot = (r: Row) => {
    const s = queueState(r.state);
    return (
      <StatusDot tone={s.tone} size="sm">
        {s.label}
      </StatusDot>
    );
  };

  // The recipient opens the row's evidence drawer; the address underlines on hover so it reads as one.
  const addressButton = (r: Row) => (
    <Button
      size="sm"
      variant="ghost"
      className="pr-queue-addr-btn"
      aria-label={`Delivery details for ${r.address}`}
      onClick={() => {
        setDetails(r);
      }}
    >
      <span className="pr-admin-mono pr-queue-addr">{r.address}</span>
    </Button>
  );

  const rowActions = (r: Row) => (
    <QueueActions
      address={r.address}
      sesConfigured={sesConfigured}
      onPick={(kind) => {
        pick(r, kind);
      }}
    />
  );

  // Admin critique X8: rem, % or auto only — a minmax()/fr width is dropped by the table, which is
  // what truncated "Next attempt".
  const columns: TableColumn<Row>[] = [
    { key: 'address', header: 'Recipient', width: 'auto', cell: addressButton },
    { key: 'subject', header: 'Subject', width: '30%', cell: (r) => <span title={r.subject ?? undefined}>{r.subject ?? '(no subject)'}</span> },
    { key: 'state', header: 'State', width: '8rem', cell: stateDot },
    { key: 'transport', header: 'Transport', width: '6.5rem', cell: (r) => <span className="pr-admin-mono">{r.transport}</span> },
    { key: 'attempts', header: 'Attempts', width: '6rem', numeric: true, align: 'end', cell: (r) => String(r.attempts) },
    { key: 'nextAttemptAt', header: 'Next attempt', width: '8.5rem', cell: (r) => <RelativeTime iso={r.nextAttemptAt} /> },
    { key: 'actions', header: hidden('Actions'), width: '5rem', align: 'end', cell: rowActions },
  ];

  const filtered = domain !== '' || state !== '' || message !== '';
  const empty = filtered ? (
    <EmptyState kind="no-results" heading="No recipients match" headingLevel={3} size={phone ? 'inline' : 'row'} />
  ) : (
    <EmptyState kind="empty" heading="Nothing queued" headingLevel={3} size={phone ? 'inline' : 'row'} />
  );

  return (
    <Page>
      <PageHeader
        title="Outbound queue"
        description="Queued, deferred, held and failed outbound mail. Filter by a domain to act on all of its recipients at once."
      />

      {message === '' ? null : (
        <Alert
          tone="info"
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setFilter('message', '');
              }}
            >
              Show all
            </Button>
          }
        >
          Showing one message’s recipients only.
        </Alert>
      )}

      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      <Card as="section" aria-label="Queued recipients" className="pr-table-card">
        <FilterBar
          className="pr-table-toolbar"
          aria-label="Filter the queue"
          trailing={
            <>
              {current === null ? null : <span data-testid="queue-count">{recipientCount(current.count, current.capped)}</span>}
              {domain === '' ? null : (
                <DomainActions
                  domain={domain}
                  sesConfigured={sesConfigured}
                  onPick={(kind, label) => {
                    openConfirm({ kind: 'domain', domain }, kind, label);
                  }}
                />
              )}
            </>
          }
        >
          <SearchField
            aria-label="Domain"
            placeholder="Filter by domain"
            value={domainText}
            onChange={(e) => {
              setDomainText(e.target.value.trim().toLowerCase());
            }}
          />
          <SegmentedControl
            aria-label="State"
            value={state}
            onValueChange={(v) => {
              setFilter('state', v);
            }}
            items={queueSegmentItems(narrowed, phone)}
          />
        </FilterBar>

        {current?.capped === true ? (
          <p className="pr-card-note" data-testid="queue-capped">
            Showing the first {QUEUE_LIST_CAP} by next attempt. Filter by a domain or a state to see the rest.
          </p>
        ) : null}
        {loadError !== null ? (
          <div className="pr-card-note">
            <LoadFailed error={loadError} what="the queue" onRetry={() => void load(domain)} />
          </div>
        ) : shown === null ? (
          <div className="pr-card-note">
            <Loading label="Loading the queue" />
          </div>
        ) : phone ? (
          <DataList aria-label="Outbound queue" className="pr-card-list" empty={empty}>
            {shown.map((r) => (
              <DataListRow
                key={r.id}
                title={addressButton(r)}
                description={
                  <>
                    {r.subject ?? '(no subject)'} · <span className="pr-admin-mono">{r.transport}</span> · {String(r.attempts)} {r.attempts === 1 ? 'attempt' : 'attempts'} · next{' '}
                    <RelativeTime iso={r.nextAttemptAt} />
                  </>
                }
                meta={stateDot(r)}
                truncate={false}
                actions={rowActions(r)}
              />
            ))}
          </DataList>
        ) : (
          <Table className="pr-admin-table pr-admin-table--fixed" caption="Outbound queue" captionHidden columns={columns} rows={shown} rowKey={(r) => r.id} empty={empty} />
        )}
      </Card>

      <QueueDrawer
        row={details}
        onClose={() => {
          setDetails(null);
        }}
        onlyThisMessage={
          message === ''
            ? (id) => {
                setDetails(null);
                setFilter('message', id);
              }
            : null
        }
      />

      <Modal
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.label ?? 'Confirm'}
        description="This is destructive. Enter a code from your authenticator; it stays valid for five minutes."
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="submit" form="queue-confirm" variant={pending?.action === 'delete' ? 'danger' : 'primary'} loading={busy}>
              Verify and {pending === null ? 'confirm' : ACTION_LABEL[pending.action].toLowerCase()}
            </Button>
          </>
        }
      >
        <form id="queue-confirm" onSubmit={(e) => { void confirm(e); }}>
          <Stack gap="12">
            {pending?.action === 'delete' ? (
              <FormField label="Reason" help="Recorded on the audit entry.">
                <Input appearance="filled"
                  required
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                  }}
                />
              </FormField>
            ) : null}
            <FormField label="Authentication code" {...(codeError === null ? {} : { error: codeError })}>
              <Input appearance="filled"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*"
                autoFocus
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
