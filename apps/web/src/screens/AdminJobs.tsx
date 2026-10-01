import { useCallback, useEffect, useState } from 'react';
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
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  SegmentedControl,
  type SegmentedControlItem,
  Select,
  StatusDot,
  type StatusDotTone,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, INBOUND_STAGES, api, describeError, serverUnreachable, type AdminJob, type InboundStage } from '../api';
import { RelativeTime, relativeTime } from '../components/RelativeTime';
import { MoreIcon } from '../mail/thread/icons';
import { PHONE_QUERY, useMediaQuery } from '../mail/useMedia';
import { Loading, LoadFailed } from './states';
import '../admin/admin.css';
import '../admin/lists.css';

/** The job states, in the order an operator triages them: what failed for good, what will retry, … */
export const JOB_STATUSES = ['dead', 'failed', 'pending', 'running', 'done'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The API's default page (apps/api/src/admin-jobs: `take: limit ?? 200`): at it, counts may be short. */
export const JOB_LIST_CAP = 200;

/** PST-T-16.4 (PST-REQ-198): ?status= is the filter, so a reload or Back keeps it; anything else is All. */
export function statusFrom(params: URLSearchParams): '' | JobStatus {
  const value = params.get('status') ?? '';
  return (JOB_STATUSES as readonly string[]).includes(value) ? (value as JobStatus) : '';
}

/**
 * How many jobs are in each state, counted from the unfiltered list — or null when that list hit the
 * API's page size, so a count would be a lie (the segments then show no numbers rather than wrong ones).
 */
export function jobCounts(all: readonly Pick<AdminJob, 'status'>[], cap: number = JOB_LIST_CAP): Record<JobStatus, number> | null {
  if (all.length >= cap) return null;
  const counts: Record<JobStatus, number> = { dead: 0, failed: 0, pending: 0, running: 0, done: 0 };
  for (const job of all) if (job.status in counts) counts[job.status as JobStatus] += 1;
  return counts;
}

const statusLabel = (status: string): string => status.charAt(0).toUpperCase() + status.slice(1);

/** The SegmentedControl's items: All, then each state, with its count when the count is honest. */
export function statusItems(all: readonly Pick<AdminJob, 'status'>[] | null): SegmentedControlItem[] {
  const counts = all === null ? null : jobCounts(all);
  const withCount = (n: number | undefined) => (n === undefined ? {} : { count: n });
  return [
    { value: '', label: 'All', ...withCount(counts === null || all === null ? undefined : all.length) },
    ...JOB_STATUSES.map((s) => ({ value: s, label: statusLabel(s), ...withCount(counts?.[s]) })),
  ];
}

/** What a row offers (critique 2.6 #3): Replay on a job that failed; "Run again", out of the way, on a done one. */
export function jobAction(status: string): 'replay' | 'run-again' | null {
  if (status === 'dead' || status === 'failed') return 'replay';
  if (status === 'done') return 'run-again';
  return null;
}

/** The first line of a stack-trace-sized error: what a one-line cell or card can honestly show. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
}

const STAGE_OPTIONS = INBOUND_STAGES.map((s) => ({ value: s, label: s }));

/** D-016: pending, running and done are neutral (done is healthy, not parked); a failed job that will retry asks; a dead one failed. */
const STATUS_TONE: Record<string, StatusDotTone> = {
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

const jobName = (j: AdminJob): string => `${j.queue} job from ${relativeTime(j.createdAt)}`;

/**
 * PST-REQ-128: failed job stages, filterable by status, each replayable from a chosen stage. An
 * inbound-queue job replays one message's pipeline stages (PST-T-2.7); anything else replays the
 * job itself.
 */
export function AdminJobs() {
  const [jobs, setJobs] = useState<AdminJob[] | null>(null);
  // Every state's count comes from the unfiltered list; the table itself is the server's filtered one.
  const [all, setAll] = useState<AdminJob[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [params, setParams] = useSearchParams();
  const status = statusFrom(params);
  const phone = useMediaQuery(PHONE_QUERY);
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
      const everything = (await api.adminJobs()).jobs;
      setAll(everything);
      setJobs(s === '' ? everything : (await api.adminJobs({ status: s })).jobs);
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

  const statusDot = (j: AdminJob) => (
    <StatusDot tone={STATUS_TONE[j.status] ?? 'neutral'} size="sm">
      {statusLabel(j.status)}
    </StatusDot>
  );

  const rowAction = (j: AdminJob) => {
    const action = jobAction(j.status);
    if (action === 'replay')
      return (
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Replay ${jobName(j)}`}
          onClick={() => {
            openReplay(j);
          }}
        >
          Replay
        </Button>
      );
    if (action === 'run-again')
      // A done job is healthy: its one action stays out of the eye's way, behind ⋯ (critique 2.6 #3).
      return (
        <Menu>
          <MenuTrigger>
            <IconButton size="sm" variant="ghost" label={`More actions for the ${jobName(j)}`} icon={<MoreIcon />} />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem
              onSelect={() => {
                openReplay(j);
              }}
            >
              Run again
            </MenuItem>
          </MenuContent>
        </Menu>
      );
    return null;
  };

  const lastError = (j: AdminJob) =>
    j.lastError === null ? (
      <span className="pr-muted">—</span>
    ) : (
      <span className="pr-mono pr-muted pr-clip" title={j.lastError}>
        {firstLine(j.lastError)}
      </span>
    );

  const attempts = (j: AdminJob) => <span title={`${String(j.attempts)} of ${String(j.maxAttempts)} allowed`}>{String(j.attempts)}</span>;

  const columns: TableColumn<AdminJob>[] = [
    { key: 'queue', header: 'Queue', width: '9rem', cell: (j) => <span className="pr-mono">{j.queue}</span> },
    { key: 'status', header: 'Status', width: '8rem', cell: statusDot },
    { key: 'attempts', header: 'Attempts', width: '6rem', numeric: true, cell: attempts },
    { key: 'lastError', header: 'Last error', width: 'auto', cell: lastError },
    { key: 'createdAt', header: 'Created', width: '8rem', cell: (j) => <RelativeTime iso={j.createdAt} /> },
    { key: 'actions', header: <span className="pr-sr-only">Actions</span>, width: '7rem', align: 'end', cell: rowAction },
  ];

  const empty = (
    <EmptyState kind={status === '' ? 'empty' : 'no-results'} heading={status === '' ? 'No jobs' : `No ${status} jobs`} headingLevel={2} size={phone ? 'inline' : 'row'} />
  );

  return (
    <Page>
      <PageHeader title="Jobs" description="Job stages with their failures, and a replay for one message's pipeline stages." />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}
      <Card className="pr-table-card">
        <div className="pr-table-toolbar">
          <FilterBar
            aria-label="Filter jobs"
            trailing={jobs === null ? null : <span>{`${String(jobs.length)} ${jobs.length === 1 ? 'job' : 'jobs'}`}</span>}
          >
            <SegmentedControl aria-label="Status" activationMode="manual" items={statusItems(all)} value={status} onValueChange={setStatus} />
          </FilterBar>
        </div>
        {loadError !== null ? (
          <LoadFailed error={loadError} what="jobs" onRetry={() => void load(status)} />
        ) : jobs === null ? (
          <Loading label="Loading jobs" />
        ) : phone ? (
          <DataList aria-label="Jobs" empty={empty}>
            {jobs.map((j) => (
              <DataListRow
                truncate={false}
                key={j.id}
                title={<span className="pr-mono">{j.queue}</span>}
                meta={statusDot(j)}
                description={
                  <>
                    {j.lastError === null ? 'No error' : firstLine(j.lastError)} · <RelativeTime iso={j.createdAt} /> · {String(j.attempts)}{' '}
                    {j.attempts === 1 ? 'attempt' : 'attempts'}
                  </>
                }
                actions={rowAction(j)}
              />
            ))}
          </DataList>
        ) : (
          <Table
            className="pr-admin-table pr-admin-table--fixed"
            caption="Jobs"
            captionHidden
            columns={columns}
            rows={jobs}
            rowKey={(j) => j.id}
            empty={empty}
          />
        )}
      </Card>

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
            appearance="filled"
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
