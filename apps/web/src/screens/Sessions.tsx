import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
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
import { ApiError, api, describeError, type AccountSession } from '../api';
import { Loading, LoadFailed } from './states';

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Your own live web sessions (PST-REQ-091; ASVS 5.0 7.5.2): every device signed in as you, right
 * now. Ending one — never the one rendering this page — needs a TOTP code from the last five
 * minutes; the server answers 403 step_up_required and the code prompt opens, then the end is
 * retried once the code is accepted.
 */
export function Sessions() {
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<AccountSession | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSessions((await api.sessions()).sessions);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const end = async (session: AccountSession): Promise<void> => {
    setNotice(null);
    try {
      await api.endSession(session.id);
      setPending(null);
      setNotice('Signed that session out.');
      await load();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'step_up_required') {
        setCode('');
        setCodeError(null);
        setPending(session);
        return;
      }
      setNotice(describeError(caught));
    }
  };

  const confirmStepUp = (event: SyntheticEvent) => {
    event.preventDefault();
    if (pending === null) return;
    setBusy(true);
    setCodeError(null);
    api
      .stepUp(code)
      .then(() => end(pending))
      .catch((caught: unknown) => {
        setCode('');
        setCodeError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const columns: TableColumn<AccountSession>[] = [
    {
      key: 'device',
      header: 'Session',
      cell: (s) => (
        <Stack gap="4">
          <span>{s.userAgent ?? 'Unknown device'}</span>
          {s.current ? <Badge size="sm">This session</Badge> : null}
        </Stack>
      ),
    },
    { key: 'createdAt', header: 'Signed in', cell: (s) => when(s.createdAt) },
    { key: 'ip', header: 'From', cell: (s) => s.ip ?? 'Unknown' },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (s) =>
        s.current ? null : (
          <Button
            variant="danger-ghost"
            size="sm"
            data-session-id={s.id}
            aria-label={`Sign out the session from ${s.ip ?? 'an unknown address'}`}
            onClick={() => {
              void end(s);
            }}
          >
            Sign out
          </Button>
        ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Devices"
        description="Every device signed in to Postroom as you, right now."
        {...(sessions === null ? {} : { count: sessions.length, countNoun: { one: 'session', other: 'sessions' } })}
      />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}
      {loadError !== null ? (
        <LoadFailed error={loadError} what="your sessions" onRetry={() => void load()} />
      ) : sessions === null ? (
        <Loading label="Loading your sessions" />
      ) : (
        <Table
          caption="Your live sessions"
          captionHidden
          columns={columns}
          rows={sessions}
          rowKey={(s) => s.id}
          empty={<EmptyState kind="empty" heading="No live sessions" size="row" />}
        />
      )}

      <Modal
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title="Confirm it is you"
        description="Ending a session is destructive. Enter a code from your authenticator; it stays valid for five minutes."
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="submit" form="sessions-step-up" variant="danger" loading={busy}>
              Verify and sign out
            </Button>
          </>
        }
      >
        <form id="sessions-step-up" onSubmit={confirmStepUp}>
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
        </form>
      </Modal>
    </Page>
  );
}
