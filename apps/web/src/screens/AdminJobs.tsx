import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  EmptyState,
  FormField,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  Select,
  StatusDot,
  type StatusDotTone,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, INBOUND_STAGES, api, describeError, serverUnreachable, type AdminJob, type InboundStage } from '../api';
import { Loading, LoadFailed } from './states';
import '../admin/admin.css';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'dead', label: 'Dead' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
];

/** PST-T-16.4 (PST-REQ-198): ?status= is the filter, so a reload or Back keeps it; anything else is All. */
function statusFrom(params: URLSearchParams): string {
  const value = params.get('status') ?? '';
  return STATUS_OPTIONS.some((o) => o.value === value) ? value : '';
}

const STAGE_OPTIONS = INBOUND_STAGES.map((s) => ({ value: s, label: s }));

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** D-016: pending, running and done are neutral; a failed job that will retry asks; a dead one failed. */
const STATUS_TONE: Record<string, StatusDotTone> = {
  pending: 'neutral',
  running: 'neutral',
  done: 'idle',
  failed: 'attention',
  dead: 'danger',
};

const statusLabel = (status: string): string => status.charAt(0).toUpperCase() + status.slice(1);

/** payload.inboundMessageId, for an 'inbound' queue job (apps/worker/src/stages/types.ts's contract). */
function inboundMessageIdOf(job: AdminJob): string | null {
  if (job.queue !== 'inbound') return null;
  const payload = job.payload;
  const id = typeof payload === 'object' && payload !== null ? (payload as { inboundMessageId?: unknown }).inboundMessageId : undefined;
  return typeof id === 'string' ? id : null;
}

/**
 * PST-REQ-128: failed job stages, filterable by status, each replayable from a chosen stage. An
 * inbound-queue job replays one message's pipeline stages (PST-T-2.7); anything else replays the
 * job itself.
 */
export function AdminJobs() {
  const [jobs, setJobs] = useState<AdminJob[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [params, setParams] = useSearchParams();
  const status = statusFrom(params);
  // Choosing a status rewrites the URL in place: the filter is part of this page, not a page of its own.
  const setStatus = (next: string): void => {
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next === '') out.delete('status');
        else out.set('status', next);
        return out;
      },
      { replace: true },
    );
  };
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<AdminJob | null>(null);
  const [stage, setStage] = useState<InboundStage>('file');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (s: string) => {
    try {
      setJobs((await api.adminJobs(s === '' ? {} : { status: s })).jobs);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load(status);
  }, [load, status]);

  const replaySimple = async (job: AdminJob): Promise<void> => {
    setNotice(null);
    try {
      await api.replayJob(job.id);
      setNotice(`Replaying job ${job.id}.`);
      await load(status);
    } catch (caught) {
      setNotice(describeError(caught));
    }
  };

  const openReplay = (job: AdminJob): void => {
    const inboundId = inboundMessageIdOf(job);
    if (inboundId === null) {
      void replaySimple(job);
      return;
    }
    setStage('file');
    setPending(job);
  };

  const confirmReplay = async (): Promise<void> => {
    if (pending === null) return;
    const inboundId = inboundMessageIdOf(pending);
    if (inboundId === null) return;
    setBusy(true);
    try {
      const result = await api.replayInbound(inboundId, stage);
      setPending(null);
      setNotice(`Replaying from "${result.fromStage}" — job ${result.jobId} re-filing message ${inboundId}.`);
      await load(status);
    } catch (caught) {
      if (caught instanceof ApiError) setNotice(describeError(caught));
      else setNotice(serverUnreachable('Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumn<AdminJob>[] = [
    { key: 'queue', header: 'Queue', cell: (j) => <span className="pr-mono">{j.queue}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (j) => (
        <StatusDot tone={STATUS_TONE[j.status] ?? 'neutral'} size="sm">
          {statusLabel(j.status)}
        </StatusDot>
      ),
    },
    { key: 'attempts', header: 'Attempts', numeric: true, cell: (j) => `${String(j.attempts)}/${String(j.maxAttempts)}` },
    {
      key: 'lastError',
      header: 'Last error',
      cell: (j) => (j.lastError === null ? <span className="pr-muted">—</span> : <span className="pr-mono pr-muted pr-wrap">{j.lastError}</span>),
    },
    { key: 'createdAt', header: 'Created', cell: (j) => when(j.createdAt) },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (j) =>
        j.status === 'pending' || j.status === 'running' ? null : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              openReplay(j);
            }}
          >
            Replay
          </Button>
        ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Jobs"
        description="Job stages with their failures, and a replay for one message's pipeline stages."
        {...(jobs === null ? {} : { count: jobs.length, countNoun: { one: 'job', other: 'jobs' } })}
      />
      <FormField label="Status" width="sm">
        <Select appearance="filled"
          options={STATUS_OPTIONS}
          value={status}
          onValueChange={(v) => {
            setStatus(v);
          }}
        />
      </FormField>
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}
      {loadError !== null ? (
        <LoadFailed error={loadError} what="jobs" onRetry={() => void load(status)} />
      ) : jobs === null ? (
        <Loading label="Loading jobs" />
      ) : (
        <Table
          className="pr-admin-table"
          caption="Jobs"
          captionHidden
          columns={columns}
          rows={jobs}
          rowKey={(j) => j.id}
          empty={<EmptyState kind="empty" heading="No jobs" size="row" />}
        />
      )}

      <Modal
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title="Replay from a stage"
        description="Runs the message's pipeline stages again from the stage chosen onward. Every stage is idempotent, so this never files a message twice."
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button
              type="button"
              variant="primary"
              loading={busy}
              onClick={() => {
                void confirmReplay();
              }}
            >
              Replay
            </Button>
          </>
        }
      >
        <FormField label="From stage">
          <Select appearance="filled"
            options={STAGE_OPTIONS}
            value={stage}
            onValueChange={(v) => {
              setStage(v as InboundStage);
            }}
          />
        </FormField>
      </Modal>
    </Page>
  );
}
