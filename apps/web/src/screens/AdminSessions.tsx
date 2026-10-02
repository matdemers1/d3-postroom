import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DataList,
  DataListRow,
  EmptyState,
  FormField,
  Input,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, api, describeError, type AdminSession } from '../api';
import { RelativeTime } from '../components/RelativeTime';
import { PHONE_QUERY, useMediaQuery } from '../mail/useMedia';
import { describeAgent } from './agent';
import { CURRENT_SESSION_LABEL, END_SESSION_LABEL } from './Sessions';
import { Loading, LoadFailed } from './states';
import '../admin/admin.css';
import '../admin/lists.css';

/** "Password" or "D3 Auth": how the session was signed in. */
export const methodLabel = (method: string): string => (method === 'oidc' ? 'D3 Auth' : 'Password');

/** "3 sessions": the toolbar's count. */
export const sessionCount = (n: number): string => `${String(n)} ${n === 1 ? 'session' : 'sessions'}`;

/**
 * Every live web session, and the demonstration destructive action for PST-REQ-008: revoking one
 * needs a TOTP code from the last five minutes. The server decides — a 403 step_up_required opens
 * the code prompt, and the revoke is retried once the code is accepted.
 *
 * PST-T-17.2: the list sits in a card; the device is a column of its own ("Chrome on macOS", the full
 * user agent on hover) instead of a Details disclosure inside the row; the session you are using is
 * marked in words, not a pill; and on a phone each session is a card with Sign out on it.
 */
export function AdminSessions() {
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<AdminSession | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const phone = useMediaQuery(PHONE_QUERY);

  const load = useCallback(async () => {
    try {
      setSessions((await api.adminSessions()).sessions);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
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

  // One action, so one secondary button — never red in the row; the step-up modal carries the weight.
  const signOut = (s: AdminSession) =>
    s.current ? null : (
      <Button
        variant="secondary"
        size="sm"
        data-session-id={s.id}
        aria-label={`${END_SESSION_LABEL} ${s.displayName}'s session from ${s.ip ?? 'an unknown address'}`}
        onClick={() => {
          void revoke(s);
        }}
      >
        {END_SESSION_LABEL}
      </Button>
    );

  const device = (s: AdminSession) => (
    <span className="pr-clip" {...(s.userAgent === null ? {} : { title: s.userAgent })}>
      {describeAgent(s.userAgent)}
    </span>
  );

  const current = (s: AdminSession) =>
    s.current ? (
      <span className="pr-list-aside">
        <span aria-hidden="true"> · </span>
        <span>{CURRENT_SESSION_LABEL}</span>
      </span>
    ) : null;

  const columns: TableColumn<AdminSession>[] = [
    {
      key: 'displayName',
      header: 'Account',
      width: 'auto',
      cell: (s) => (
        <span className="pr-clip">
          {s.displayName}
          {current(s)}
        </span>
      ),
    },
    { key: 'device', header: 'Device', width: '14rem', cell: device },
    { key: 'method', header: 'Signed in with', width: '8rem', cell: (s) => methodLabel(s.method) },
    { key: 'createdAt', header: 'Since', width: '8rem', cell: (s) => <RelativeTime iso={s.createdAt} /> },
    { key: 'ip', header: 'From', width: '9rem', cell: (s) => (s.ip === null ? <span className="pr-muted">Unknown</span> : <span className="pr-mono">{s.ip}</span>) },
    { key: 'actions', header: <span className="pr-sr-only">Actions</span>, width: '7rem', align: 'end', cell: signOut },
  ];

  return (
    <Page>
      <PageHeader title="Sign-in sessions" description="Everyone signed in to the web app right now." />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}
      <Card className="pr-table-card">
        {sessions === null ? null : (
          <div className="pr-table-toolbar">
            <span className="pr-list-count">{sessionCount(sessions.length)}</span>
          </div>
        )}
        {loadError !== null ? (
          <LoadFailed error={loadError} what="sessions" onRetry={() => void load()} />
        ) : sessions === null ? (
          <Loading label="Loading sessions" />
        ) : phone ? (
          <DataList aria-label="Live sessions" empty={<EmptyState kind="empty" heading="No live sessions" headingLevel={2} size="inline" />}>
            {sessions.map((s) => (
              <DataListRow
                truncate={false}
                key={s.id}
                title={s.displayName}
                meta={s.current ? <span>{CURRENT_SESSION_LABEL}</span> : null}
                description={
                  <span className="pr-list-desc">
                    {describeAgent(s.userAgent)} · {methodLabel(s.method)} · <RelativeTime iso={s.createdAt} />
                    {s.ip === null ? null : (
                      <>
                        {' · '}
                        <span className="pr-mono">{s.ip}</span>
                      </>
                    )}
                  </span>
                }
                actions={signOut(s)}
              />
            ))}
          </DataList>
        ) : (
          <Table
            className="pr-admin-table pr-admin-table--fixed"
            caption="Live sessions"
            captionHidden
            columns={columns}
            rows={sessions}
            rowKey={(s) => s.id}
            empty={<EmptyState kind="empty" heading="No live sessions" size="row" />}
          />
        )}
      </Card>

      <Modal
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title="Confirm it is you"
        description="Signing a session out is destructive. Enter a code from your authenticator; it stays valid for five minutes."
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="submit" form="step-up" variant="danger" loading={busy}>
              Verify and sign out
            </Button>
          </>
        }
      >
        <form id="step-up" onSubmit={confirmStepUp}>
          <FormField label="Authentication code" {...(codeError === null ? {} : { error: codeError })}>
            <Input
              appearance="filled"
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
