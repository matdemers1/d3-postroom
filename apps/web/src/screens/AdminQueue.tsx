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
  Section,
  Select,
  Stack,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, api, describeError, type AdminQueueRecipient, type QueueScope, type QueueStateFilter } from '../api';
import { Loading, LoadFailed } from './states';

const STATE_OPTIONS: { value: '' | QueueStateFilter; label: string }[] = [
  { value: '', label: 'All queued mail' },
  { value: 'pending', label: 'Pending' },
  { value: 'deferred', label: 'Deferred' },
  { value: 'held', label: 'Held (frozen credential)' },
  { value: 'failed', label: 'Failed' },
];

const STATE_TONE: Record<string, 'neutral' | 'attention' | 'danger'> = {
  queued: 'neutral',
  deferred: 'attention',
  bounced: 'danger',
};

type ActionKind = 'retry' | 'force-ses' | 'bounce' | 'delete';

const ACTION_LABEL: Record<ActionKind, string> = {
  retry: 'Retry now',
  'force-ses': 'Force SES',
  bounce: 'Bounce',
  delete: 'Delete',
};

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
 */
export function AdminQueue() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sesConfigured, setSesConfigured] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [domain, setDomain] = useState('');
  const [state, setState] = useState<'' | QueueStateFilter>('');
  const [notice, setNotice] = useState<string | null>(null);

  const [pending, setPending] = useState<{ scope: QueueScope; action: ActionKind; label: string } | null>(null);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [bulkDomain, setBulkDomain] = useState('');

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

  const columns: TableColumn<Row>[] = [
    { key: 'address', header: 'Recipient', cell: (r) => r.address },
    { key: 'subject', header: 'Subject', cell: (r) => r.subject ?? '(no subject)' },
    { key: 'domain', header: 'Domain', cell: (r) => r.domain },
    {
      key: 'state',
      header: 'State',
      cell: (r) => <Badge tone={STATE_TONE[r.state] ?? 'neutral'}>{r.state}</Badge>,
    },
    { key: 'transport', header: 'Transport', cell: (r) => r.transport },
    { key: 'attempts', header: 'Attempts', cell: (r) => String(r.attempts) },
    { key: 'nextAttemptAt', header: 'Next attempt', cell: (r) => when(r.nextAttemptAt) },
    { key: 'lastText', header: 'Last response', cell: (r) => r.lastText ?? '—' },
    {
      key: 'timeline',
      header: 'Timeline',
      cell: (r) => (
        <a className="pr-tbl-link" href={`/api/messages/${r.outboundMessageId}/delivery`} target="_blank" rel="noreferrer">
          View
        </a>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (r) => (
        <Cluster gap="4" justify="end">
          <Button size="sm" variant="secondary" onClick={() => { openConfirm({ kind: 'recipient', id: r.id }, 'retry', `Retry ${r.address}`); }}>
            Retry
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!sesConfigured}
            title={sesConfigured ? undefined : 'SES is not configured'}
            onClick={() => { openConfirm({ kind: 'recipient', id: r.id }, 'force-ses', `Force SES for ${r.address}`); }}
          >
            Force SES
          </Button>
          <Button size="sm" variant="secondary" onClick={() => { openConfirm({ kind: 'recipient', id: r.id }, 'bounce', `Bounce ${r.address}`); }}>
            Bounce
          </Button>
          <Button size="sm" variant="danger-ghost" onClick={() => { openConfirm({ kind: 'recipient', id: r.id }, 'delete', `Delete ${r.address}`); }}>
            Delete
          </Button>
        </Cluster>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Outbound queue"
        description="Queued, deferred, held and failed outbound mail: retry now, bounce, delete or force SES — per message, or across a whole domain below."
        {...(rows === null ? {} : { count: rows.length, countNoun: { one: 'recipient', other: 'recipients' } })}
      />
      <Cluster gap="12">
        <FormField label="Domain" width="sm">
          <Input
            value={domain}
            placeholder="example.com"
            onChange={(e) => {
              setDomain(e.target.value.trim().toLowerCase());
            }}
          />
        </FormField>
        <FormField label="State" width="sm">
          <Select
            options={STATE_OPTIONS}
            value={state}
            onValueChange={(v) => {
              setState(v as '' | QueueStateFilter);
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
        <LoadFailed error={loadError} what="the queue" onRetry={() => void load(domain, state)} />
      ) : rows === null ? (
        <Loading label="Loading the queue" />
      ) : (
        <Table
          caption="Outbound queue"
          captionHidden
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty={<EmptyState kind="empty" heading="Nothing queued" size="row" />}
        />
      )}

      <Section title="Bulk, by domain" description="Bounded to 500 recipients per request." surface="plain">
        <Cluster gap="12">
          <FormField label="Domain" width="sm">
            <Input
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
                <Input
                  required
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                  }}
                />
              </FormField>
            ) : null}
            <FormField label="Authentication code" {...(codeError === null ? {} : { error: codeError })}>
              <Input
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
