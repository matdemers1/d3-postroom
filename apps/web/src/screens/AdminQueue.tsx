import { type SyntheticEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Cluster,
  DataList,
  DataListRow,
  EmptyState,
  FormField,
  Input,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  Section,
  Select,
  Stack,
  StatusDot,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, api, describeError, type AdminQueueRecipient, type QueueScope, type QueueStateFilter } from '../api';
import { Loading, LoadFailed } from './states';
import { queueState } from '../admin/health/model';
import { QueueActions } from '../admin/queue/QueueActions';
import { QueueDrawer } from '../admin/queue/QueueDrawer';
import { filterByMessage, parseQueueFilters, QUEUE_ACTION_LABEL, QUEUE_PHONE_QUERY, type QueueActionKind, withQueueFilter } from '../admin/queue/model';
import { useMediaQuery } from '../mail/useMedia';
import '../admin/admin.css';

const STATE_OPTIONS: { value: '' | QueueStateFilter; label: string }[] = [
  { value: '', label: 'All queued mail' },
  { value: 'pending', label: 'Pending' },
  { value: 'deferred', label: 'Deferred' },
  { value: 'held', label: 'Held (frozen credential)' },
  { value: 'failed', label: 'Failed' },
];

type ActionKind = QueueActionKind;
const ACTION_LABEL = QUEUE_ACTION_LABEL;

interface Row extends AdminQueueRecipient {
  subject: string | null;
  headerFrom: string;
}

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * PST-T-6.6 / PST-REQ-121: the outbound queue admin — retry, bounce, delete and force-SES, per
 * recipient, per message, or per domain (the bulk form below the table). Every mutation needs a
 * fresh step-up (PST-REQ-008): the confirm modal always asks for a current code, since almost
 * every visit to this screen is the first destructive action in the session.
 *
 * PST-T-16.13 (PST-DA-031): the four row actions are one Actions menu, the row's evidence (last reply,
 * every attempt) is a drawer, a phone gets cards, and ?state= ?domain= ?message= hold the filters.
 */
export function AdminQueue() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sesConfigured, setSesConfigured] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [params, setParams] = useSearchParams();
  const { domain, state, message } = parseQueueFilters(params);
  const phone = useMediaQuery(QUEUE_PHONE_QUERY);
  const [details, setDetails] = useState<Row | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [pending, setPending] = useState<{ scope: QueueScope; action: ActionKind; label: string } | null>(null);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [bulkDomain, setBulkDomain] = useState('');

  // Replace, not push: typing a domain letter by letter must not fill the Back stack.
  const setFilter = (key: 'state' | 'domain' | 'message', value: string): void => {
    setParams((current) => withQueueFilter(current, key, value), { replace: true });
  };
  const shown = useMemo(() => (rows === null ? null : filterByMessage(rows, message)), [rows, message]);

  const load = useCallback(async (d: string, s: '' | QueueStateFilter) => {
    try {
      const result = await api.adminQueue({ ...(d === '' ? {} : { domain: d }), ...(s === '' ? {} : { state: s }) });
      setRows(result.messages.flatMap((m) => m.recipients.map((r) => ({ ...r, subject: m.subject, headerFrom: m.headerFrom }))));
      setSesConfigured(result.sesConfigured);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load(domain, state);
  }, [load, domain, state]);

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
      await load(domain, state);
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

  const columns: TableColumn<Row>[] = [
    {
      key: 'address',
      header: 'Recipient',
      width: 'minmax(0, 1.4fr)',
      cell: (r) => (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Delivery details for ${r.address}`}
          onClick={() => {
            setDetails(r);
          }}
        >
          <span className="pr-mono pr-queue-addr">{r.address}</span>
        </Button>
      ),
    },
    { key: 'subject', header: 'Subject', width: 'minmax(0, 1.4fr)', cell: (r) => r.subject ?? '(no subject)' },
    { key: 'state', header: 'State', width: '7.5rem', cell: stateDot },
    { key: 'transport', header: 'Transport', width: '6rem', cell: (r) => <span className="pr-mono">{r.transport}</span> },
    { key: 'attempts', header: 'Attempts', width: '6rem', numeric: true, cell: (r) => String(r.attempts) },
    { key: 'nextAttemptAt', header: 'Next attempt', width: '11rem', cell: (r) => when(r.nextAttemptAt) },
    {
      key: 'actions',
      header: 'Actions',
      width: '6.5rem',
      align: 'end',
      cell: (r) => (
        <QueueActions
          address={r.address}
          sesConfigured={sesConfigured}
          onPick={(kind) => {
            pick(r, kind);
          }}
        />
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Outbound queue"
        description="Queued, deferred, held and failed outbound mail: retry now, bounce, delete or force SES — per message, or across a whole domain below."
        {...(shown === null ? {} : { count: shown.length, countNoun: { one: 'recipient', other: 'recipients' } })}
      />
      <Cluster gap="12">
        <FormField label="Domain" width="sm">
          <Input appearance="filled"
            value={domain}
            placeholder="example.com"
            onChange={(e) => {
              setFilter('domain', e.target.value.trim().toLowerCase());
            }}
          />
        </FormField>
        <FormField label="State" width="sm">
          <Select appearance="filled"
            options={STATE_OPTIONS}
            value={state}
            onValueChange={(v) => {
              setFilter('state', v);
            }}
          />
        </FormField>
      </Cluster>

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

      {loadError !== null ? (
        <LoadFailed error={loadError} what="the queue" onRetry={() => void load(domain, state)} />
      ) : shown === null ? (
        <Loading label="Loading the queue" />
      ) : phone ? (
        <DataList aria-label="Outbound queue" empty={<EmptyState kind="empty" heading="Nothing queued" headingLevel={3} size="inline" />}>
          {shown.map((r) => (
            <DataListRow
              key={r.id}
              title={
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delivery details for ${r.address}`}
                  onClick={() => {
                    setDetails(r);
                  }}
                >
                  <span className="pr-mono pr-queue-addr">{r.address}</span>
                </Button>
              }
              description={`${r.subject ?? '(no subject)'} · ${r.transport} · ${String(r.attempts)} ${r.attempts === 1 ? 'attempt' : 'attempts'} · next ${when(r.nextAttemptAt)}`}
              meta={stateDot(r)}
              truncate={false}
              actions={
                <QueueActions
                  address={r.address}
                  sesConfigured={sesConfigured}
                  onPick={(kind) => {
                    pick(r, kind);
                  }}
                />
              }
            />
          ))}
        </DataList>
      ) : (
        <Table
          className="pr-admin-table pr-admin-table--fixed"
          caption="Outbound queue"
          captionHidden
          columns={columns}
          rows={shown}
          rowKey={(r) => r.id}
          empty={<EmptyState kind="empty" heading="Nothing queued" size="row" />}
        />
      )}

      <Section title="Bulk, by domain" description="Bounded to 500 recipients per request." surface="plain">
        <Cluster gap="12">
          <FormField label="Domain" width="sm">
            <Input appearance="filled"
              value={bulkDomain}
              placeholder="example.com"
              onChange={(e) => {
                setBulkDomain(e.target.value.trim().toLowerCase());
              }}
            />
          </FormField>
          <Button
            variant="secondary"
            disabled={bulkDomain === ''}
            onClick={() => { openConfirm({ kind: 'domain', domain: bulkDomain }, 'retry', `Retry every recipient at ${bulkDomain}`); }}
          >
            Retry domain
          </Button>
          <Button
            variant="secondary"
            disabled={bulkDomain === '' || !sesConfigured}
            onClick={() => { openConfirm({ kind: 'domain', domain: bulkDomain }, 'force-ses', `Force SES for ${bulkDomain}`); }}
          >
            Force SES for domain
          </Button>
          <Button
            variant="secondary"
            disabled={bulkDomain === ''}
            onClick={() => { openConfirm({ kind: 'domain', domain: bulkDomain }, 'bounce', `Bounce every recipient at ${bulkDomain}`); }}
          >
            Bounce domain
          </Button>
          <Button
            variant="danger-ghost"
            disabled={bulkDomain === ''}
            onClick={() => { openConfirm({ kind: 'domain', domain: bulkDomain }, 'delete', `Delete every recipient at ${bulkDomain}`); }}
          >
            Delete domain
          </Button>
        </Cluster>
      </Section>

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
