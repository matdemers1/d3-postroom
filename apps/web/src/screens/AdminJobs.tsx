import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  FormField,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  Select,
  Skeleton,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, INBOUND_STAGES, api, describeError, type AdminJob, type InboundStage } from '../api';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'dead', label: 'Dead' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
];

const STAGE_OPTIONS = INBOUND_STAGES.map((s) => ({ value: s, label: s }));

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const STATUS_TONE: Record<string, 'neutral' | 'attention' | 'danger'> = {
  pending: 'neutral',
  running: 'neutral',
  done: 'neutral',
  failed: 'attention',
  dead: 'danger',
};

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
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<AdminJob | null>(null);
  const [stage, setStage] = useState<InboundStage>('file');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (s: string) => {
    try {
      setJobs((await api.adminJobs(s === '' ? {} : { status: s })).jobs);
      setLoadError(false);
    } catch {
      setLoadError(true);
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
      else setNotice('Postroom did not answer. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumn<AdminJob>[] = [
    { key: 'queue', header: 'Queue', cell: (j) => j.queue },
    {
      key: 'status',
      header: 'Status',
      cell: (j) => <Badge tone={STATUS_TONE[j.status] ?? 'neutral'}>{j.status}</Badge>,
    },
    { key: 'attempts', header: 'Attempts', cell: (j) => `${String(j.attempts)}/${String(j.maxAttempts)}` },
    { key: 'lastError', header: 'Last error', cell: (j) => j.lastError ?? '—' },
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
        <Select
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
      {loadError ? (
        <EmptyState kind="error" heading="Could not load jobs" headingLevel={2} action={<Button onClick={() => void load(status)}>Try again</Button>}>
          The server did not answer.
        </EmptyState>
      ) : jobs === null ? (
        <Skeleton variant="block" />
      ) : (
        <Table
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
          <Select
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
