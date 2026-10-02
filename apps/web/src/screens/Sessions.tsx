import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Button, DataList, DataListRow, DescriptionItem, DescriptionList, EmptyState, FormField, Input, Modal, ModalClose, Page, PageHeader, Section, StatusDot } from '@d3cloud/ui';
import { ApiError, api, describeError, type AccountSession } from '../api';
import { RelativeTime } from '../components/RelativeTime';
import { describeAgent } from './agent';
import { SECURITY_DESCRIPTION } from './device/security';
import { Loading, LoadFailed } from './states';
import { SubNav } from './SubNav';

/** PST-T-16.17: one verb for ending a browser session, and one name for the one you are using. */
export const END_SESSION_LABEL = 'Sign out';
export const CURRENT_SESSION_LABEL = 'This browser';

// A 200-character user agent has no spaces to break on; wrap it rather than widen the row.
const WRAP = { overflowWrap: 'anywhere' } as const;

/**
 * The evidence behind a session's friendly name: the full user agent and the IP, behind a native
 * disclosure (keyboard-operable, no state to keep). Admin › Sign-in sessions still uses it; your own
 * Browser sessions shows the user agent on hover of the row's description instead (PST-T-17.9).
 */
export function SessionDetails({ userAgent, ip }: { userAgent: string | null; ip: string | null }) {
  return (
    <details className="pr-session-details">
      {/* Named for its session, so ten rows are not ten identical "Details" (the visible word leads, WCAG 2.5.3). */}
      <summary aria-label={`Details for ${describeAgent(userAgent)}`}>Details</summary>
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

/** How a session row reads: its title, what leads its description, and whether it is marked as yours. */
export interface SessionRowText {
  title: string;
  /** Leads the one-line description, before "signed in …": the IP, after the agent when the title could not name it. */
  lead: string;
  /** True when the row carries the "This browser" marker on its right edge. */
  marked: boolean;
}

/**
 * PST-T-17.9 (critique 2.3): the session you are using is called "This browser" exactly once — as its
 * title when the agent cannot be named ("Unknown browser" says nothing to the person holding it), or
 * as a marker on the row's right edge beside a named agent ("Chrome on macOS").
 */
export function sessionRowText(s: Pick<AccountSession, 'userAgent' | 'ip' | 'current'>): SessionRowText {
  const agent = describeAgent(s.userAgent);
  const unnamed = agent === 'Unknown device' || agent === 'Unknown browser';
  const ip = s.ip ?? 'Unknown address';
  if (s.current && unnamed) return { title: CURRENT_SESSION_LABEL, lead: `${agent} · ${ip}`, marked: false };
  return { title: agent, lead: ip, marked: s.current };
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
    // PST-T-17.9: one constant header for all of Security & devices, then its tabs, then this card.
    <Page width="narrow" align="center">
      <PageHeader title="Security & devices" description={SECURITY_DESCRIPTION} />
      <SubNav />
      <Section title="Signed in now" description="Browsers signed in as you. Mail apps are under App passwords.">
        {notice === null ? null : (
          <Alert tone="info" dynamic>
            {notice}
          </Alert>
        )}
        {loadError !== null ? (
          <LoadFailed error={loadError} what="your sessions" onRetry={() => void load()} headingLevel={3} size="row" />
        ) : sessions === null ? (
          <Loading label="Loading your sessions" height={96} />
        ) : (
          <DataList aria-label="Your live sessions" empty={<EmptyState kind="empty" heading="No live sessions" headingLevel={3} size="row" />}>
            {sessions.map((s) => {
              const row = sessionRowText(s);
              return (
                <DataListRow
                  key={s.id}
                  title={row.title}
                  truncate={false}
                  description={
                    // The full user agent is one hover away; the line itself stays one line.
                    <span {...(s.userAgent === null ? {} : { title: s.userAgent })}>
                      {row.lead} · signed in <RelativeTime iso={s.createdAt} />
                    </span>
                  }
                  actions={
                    s.current ? (
                      row.marked ? (
                        <StatusDot size="sm" tone="neutral">
                          {CURRENT_SESSION_LABEL}
                        </StatusDot>
                      ) : null
                    ) : (
                      <Button
                        variant="secondary"
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
              );
            })}
          </DataList>
        )}
      </Section>

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
