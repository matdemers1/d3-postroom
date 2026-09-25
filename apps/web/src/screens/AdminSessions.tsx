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
  Skeleton,
  Stack,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, api, describeError, type AdminSession } from '../api';

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Every live web session, and the demonstration destructive action for PST-REQ-008: revoking one
 * needs a TOTP code from the last five minutes. The server decides — a 403 step_up_required opens
 * the code prompt, and the revoke is retried once the code is accepted.
 */
export function AdminSessions() {
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<AdminSession | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSessions((await api.adminSessions()).sessions);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (session: AdminSession): Promise<void> => {
    setNotice(null);
    try {
      await api.revokeSession(session.id);
      setPending(null);
      setNotice(`Signed out ${session.displayName}'s session.`);
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
      .then(() => revoke(pending))
      .catch((caught: unknown) => {
        setCode('');
        setCodeError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const columns: TableColumn<AdminSession>[] = [
    {
      key: 'displayName',
      header: 'Account',
      cell: (s) => (
        <Stack gap="4">
          <span>{s.displayName}</span>
          {s.current ? <Badge size="sm">This session</Badge> : null}
        </Stack>
      ),
    },
    { key: 'method', header: 'Signed in with', cell: (s) => (s.method === 'oidc' ? 'D3 Auth' : 'Password') },
    { key: 'createdAt', header: 'Since', cell: (s) => when(s.createdAt) },
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
            aria-label={`Revoke ${s.displayName}'s session from ${s.ip ?? 'an unknown address'}`}
            onClick={() => {
              void revoke(s);
            }}
          >
            Revoke
          </Button>
        ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Sessions"
        description="Everyone signed in to the web app right now."
        {...(sessions === null ? {} : { count: sessions.length, countNoun: { one: 'session', other: 'sessions' } })}
      />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}
      {loadError ? (
        <EmptyState kind="error" heading="Could not load sessions" headingLevel={2} action={<Button onClick={() => void load()}>Try again</Button>}>
          The server did not answer.
        </EmptyState>
      ) : sessions === null ? (
        <Skeleton variant="block" />
      ) : (
        <Table
          caption="Live sessions"
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
        description="Revoking a session is destructive. Enter a code from your authenticator; it stays valid for five minutes."
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="submit" form="step-up" variant="danger" loading={busy}>
              Verify and revoke
            </Button>
          </>
        }
      >
        <form id="step-up" onSubmit={confirmStepUp}>
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
