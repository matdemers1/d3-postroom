import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, DataList, DataListRow, DescriptionItem, DescriptionList, EmptyState, FormField, Input, Modal, ModalClose, Page, PageHeader, Section } from '@d3cloud/ui';
import { ApiError, api, describeError, type AccountSession } from '../api';
import { describeAgent } from './agent';
import { Loading, LoadFailed } from './states';
import { SubNav } from './SubNav';

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** PST-T-16.17: one verb for ending a browser session, and one name for the one you are using. */
export const END_SESSION_LABEL = 'Sign out';
export const CURRENT_SESSION_LABEL = 'This browser';

// A 200-character user agent has no spaces to break on; wrap it rather than widen the row.
const WRAP = { overflowWrap: 'anywhere' } as const;

/**
 * The evidence behind a session's friendly name: the full user agent and the IP, behind a native
 * disclosure (keyboard-operable, no state to keep). Shared by the account and admin screens.
 */
export function SessionDetails({ userAgent, ip }: { userAgent: string | null; ip: string | null }) {
  return (
    <details className="pr-session-details">
      <summary>Details</summary>
      <DescriptionList>
        <DescriptionItem term="User agent">
          <span className="pr-mono" style={WRAP}>{userAgent === null || userAgent.trim() === '' ? 'Unknown' : userAgent}</span>
        </DescriptionItem>
        <DescriptionItem term="IP address">
          <span className="pr-mono" style={WRAP}>{ip ?? 'Unknown'}</span>
        </DescriptionItem>
      </DescriptionList>
    </details>
  );
}

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
  const [confirming, setConfirming] = useState<AccountSession | null>(null);

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
      setConfirming(null);
      setNotice('Signed that session out.');
      await load();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'step_up_required') {
        setConfirming(null);
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

  return (
    // PST-T-15.6: the settings grid — a 680px column, the sessions as rows in one Section card.
    <Page width="narrow">
      <PageHeader
        title="Browser sessions"
        description="Every browser signed in to Postroom as you, right now. Mail apps are under Devices."
        {...(sessions === null ? {} : { count: sessions.length, countNoun: { one: 'session', other: 'sessions' } })}
      />
      <SubNav />
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
        <Section title="Signed in now" description="Signing a session out needs a fresh code from your authenticator.">
          <DataList aria-label="Your live sessions" empty={<EmptyState kind="empty" heading="No live sessions" headingLevel={3} size="inline" />}>
            {sessions.map((s) => (
              <DataListRow
                key={s.id}
                title={describeAgent(s.userAgent)}
                truncate={false}
                description={
                  <>
                    <span>{`Signed in ${when(s.createdAt)} · from ${s.ip ?? 'an unknown address'}`}</span>
                    <SessionDetails userAgent={s.userAgent} ip={s.ip} />
                  </>
                }
                meta={s.current ? <Badge size="sm">{CURRENT_SESSION_LABEL}</Badge> : null}
                actions={
                  s.current ? null : (
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      data-session-id={s.id}
                      aria-label={`${END_SESSION_LABEL} the session from ${s.ip ?? 'an unknown address'}`}
                      onClick={() => {
                        setConfirming(s);
                      }}
                    >
                      {END_SESSION_LABEL}
                    </Button>
                  )
                }
              />
            ))}
          </DataList>
        </Section>
      )}

      <Modal
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        destructive
        title="Sign out this session?"
        description={confirming === null ? '' : `${describeAgent(confirming.userAgent)} is signed out immediately.`}
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                if (confirming !== null) void end(confirming);
              }}
            >
              Sign out
            </Button>
          </>
        }
      >
        {null}
      </Modal>

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
        </form>
      </Modal>
    </Page>
  );
}
