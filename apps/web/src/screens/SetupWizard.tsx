import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Link,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
  StatusDot,
} from '@d3cloud/ui';
import {
  ApiError,
  api,
  describeError,
  dnsSummary,
  settled,
  timelineOf,
  WIZARD_CHANGED_EVENT,
  wizardReachable,
  serverUnreachable,
  type DeliveryView,
  type WizardStep,
  type WizardView,
} from '../api';
import { ResolverNote, useDnsReport } from './AdminDns';
import { PHONE_QUERY, useMediaQuery } from '../mail/useMedia';
import { CopyField } from './setup/CopyField';
import { DnsChecklist } from './setup/DnsChecklist';
import { recipientTone, recipientWord } from './setup/recipient-state';
import { summaryOf, wizardDnsGroups } from './setup/wizard-dns';
import { WizardSteps } from './setup/WizardSteps';
import '../admin/admin.css';
import './setup/wizard.css';

const POLL_MS = 2_000;

/** The page's h1 is its nav label (PST-T-17.8); the stepper, not the header, says where you are. */
const TITLE = 'Setup';
const DESCRIPTION = 'Five steps to your first delivered message.';

/** The server's own sentence for a wizard refusal when it has one; the shared wording otherwise. */
function explain(error: unknown): string {
  if (error instanceof ApiError && typeof error.body === 'object' && error.body !== null) {
    const message = (error.body as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return describeError(error);
}

type Action = () => Promise<WizardView | null>;

/**
 * After first-run setup: the operator's path from "an account exists" to "a signed test message left
 * with its delivery timeline" (PST-REQ-098). State lives on the server, so it resumes where it was
 * left, on any device. Every step is a destructive-grade admin change, so the server asks for a
 * fresh TOTP (step-up); the prompt below answers it and retries the step.
 */
export function SetupWizard() {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY);
  const [view, setView] = useState<WizardView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [current, setCurrent] = useState<WizardStep>('domain');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await api.wizard();
      setView(v);
      setCurrent(v.step);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a step; a step-up refusal opens the code prompt and the step runs again after it. */
  const run = async (action: Action, then?: (v: WizardView) => void): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const v = await action();
      if (v !== null) {
        setView(v);
        window.dispatchEvent(new Event(WIZARD_CHANGED_EVENT));
        then?.(v);
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'step_up_required') {
        setCode('');
        setCodeError(null);
        setPending(() => async () => {
          const v = await action();
          if (v !== null) then?.(v);
          return v;
        });
        return;
      }
      setError(explain(caught));
    } finally {
      setBusy(false);
    }
  };

  const confirmStepUp = (event: SyntheticEvent) => {
    event.preventDefault();
    const retry = pending;
    if (retry === null) return;
    setBusy(true);
    setCodeError(null);
    api
      .stepUp(code)
      .then(async () => {
        setPending(null);
        await run(retry);
      })
      .catch((caught: unknown) => {
        setCode('');
        setCodeError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (loadFailed) {
    return (
      <Page width="narrow" align="center">
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <EmptyState kind="error" heading="Could not load the setup wizard" headingLevel={2} action={<Button onClick={() => void load()}>Try again</Button>}>
          {serverUnreachable()}
        </EmptyState>
      </Page>
    );
  }
  if (view === null) {
    return (
      <Page width="narrow" align="center">
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <Skeleton variant="block" />
      </Page>
    );
  }

  return (
    <Page width="narrow" align="center">
      <PageHeader title={TITLE} description={view.completed ? 'Postroom is set up. Every step is done.' : DESCRIPTION} />
      <WizardSteps
        view={view}
        current={current}
        phone={phone}
        onPick={(step) => {
          setError(null);
          setCurrent(step);
        }}
      />

      {error === null ? null : (
        <Alert tone="danger" dynamic>
          {error}
        </Alert>
      )}

      {current === 'domain' ? <DomainStep view={view} busy={busy} onSubmit={(d) => void run(() => api.wizardDomain(d), () => { setCurrent('dkim'); })} /> : null}
      {current === 'dkim' ? (
        <DkimStep
          view={view}
          busy={busy}
          onGenerate={() => void run(() => api.wizardDkim())}
          onNext={() => {
            // Keys may already exist (made by the CLI, say) with the wizard not yet past this step:
            // the idempotent POST moves it on without making new ones.
            if (wizardReachable(view, 'dns')) setCurrent('dns');
            else
              void run(
                () => api.wizardDkim(),
                () => {
                  setCurrent('dns');
                },
              );
          }}
        />
      ) : null}
      {current === 'dns' && view.domain !== null ? <DnsStep domain={view.domain} busy={busy} onNext={() => void run(() => api.wizardDns(), () => { setCurrent('mailbox'); })} /> : null}
      {current === 'mailbox' ? <MailboxStep view={view} busy={busy} onSubmit={(lp) => void run(() => api.wizardMailbox(lp), () => { setCurrent('test'); })} /> : null}
      {current === 'test' || current === 'done' ? (
        <TestStep
          view={view}
          busy={busy}
          onSent={(outboundId) => run(() => api.wizardTest(outboundId))}
          onError={setError}
          onFinish={() =>
            void run(
              () => api.wizardComplete(),
              () => {
                setCurrent('done');
              },
            )
          }
          onGoToMail={() => {
            void navigate('/');
          }}
        />
      ) : null}

      <Modal
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title="Confirm it is you"
        description="Setup changes how Postroom sends mail. Enter a code from your authenticator; it stays valid for five minutes."
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="submit" form="wizard-step-up" variant="primary" loading={busy}>
              Verify and continue
            </Button>
          </>
        }
      >
        <form id="wizard-step-up" onSubmit={confirmStepUp}>
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

function DomainStep({ view, busy, onSubmit }: { view: WizardView; busy: boolean; onSubmit: (domain: string) => void }) {
  const [domain, setDomain] = useState(view.domain ?? view.suggestedDomain);
  return (
    <Section title="Mail domain" description="The domain your addresses are at. Postroom creates it here, or confirms the one first-run setup made.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(domain);
        }}
      >
        <Stack gap="16">
          <FormField label="Domain" width="lg" help="Only a domain you control. A no-reply subdomain belongs to Cloudflare Email Service and is refused.">
            <Input appearance="filled"
              name="domain"
              required
              autoComplete="off"
              spellCheck={false}
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value);
              }}
            />
          </FormField>
          <FormActions align="start">
            <Button type="submit" variant="primary" loading={busy}>
              Save domain
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Section>
  );
}

const ALGORITHM: Record<WizardView['dkim'][number]['algorithm'], string> = { 'ed25519-sha256': 'Ed25519', 'rsa-sha256': 'RSA-2048' };

function DkimStep({ view, busy, onGenerate, onNext }: { view: WizardView; busy: boolean; onGenerate: () => void; onNext: () => void }) {
  return (
    <Section
      title="DKIM keys"
      description="Every message Postroom sends is signed twice: Ed25519 and RSA-2048. The private keys are sealed under the server’s key and never leave it; publish these two TXT records."
    >
      {view.dkim.length === 0 ? (
        <EmptyState kind="empty" size="inline" heading={`No keys yet for ${view.domain ?? 'this domain'}`}>
          Generating makes both keys at once and shows the two records to publish.
        </EmptyState>
      ) : (
        <ul className="pr-dkim-keys" aria-label={`DKIM records for ${view.domain ?? 'this domain'}`}>
          {view.dkim.map((k) => (
            <li key={k.selector} className="pr-dkim-key">
              <h3 className="pr-dkim-key__title">
                {ALGORITHM[k.algorithm]} TXT record<span className="pr-dkim-key__selector">{k.selector}</span>
              </h3>
              <CopyField label="Name" oneLine value={k.dnsName} name={`${k.selector} record name`} copyLabel={`${k.selector} record name`} />
              <CopyField label="Value" value={k.dnsRecord} name={`${k.selector} record value`} copyLabel={`${k.selector} record value`} />
            </li>
          ))}
        </ul>
      )}
      <FormActions align="start">
        {view.dkim.length === 0 ? (
          <Button variant="primary" loading={busy} onClick={onGenerate}>
            Generate DKIM keys
          </Button>
        ) : (
          <Button variant="primary" loading={busy} onClick={onNext}>
            Continue to DNS
          </Button>
        )}
      </FormActions>
    </Section>
  );
}

function DnsStep({ domain, busy, onNext }: { domain: string; busy: boolean; onNext: () => void }) {
  const { report, failed, checking, check } = useDnsReport(domain);
  const groups = report === null ? null : wizardDnsGroups(report.rows);
  return (
    <Section
      title="DNS records"
      description="Publish these at your DNS host, then re-check. You can continue while some are still pending."
      actions={
        <Button
          loading={checking}
          onClick={() => {
            void check();
          }}
        >
          Re-check
        </Button>
      }
    >
      {failed ? (
        <Alert tone="danger">The DNS check didn’t answer. Try again.</Alert>
      ) : report === null || groups === null ? (
        <Skeleton variant="block" />
      ) : (
        <>
          <ResolverNote report={report} />
          <Section
            title="Publish now"
            headingLevel={3}
            surface="plain"
            description={<span aria-live="polite">{dnsSummary(summaryOf(groups.now))}</span>}
          >
            <DnsChecklist rows={groups.now} label={`Records to publish for ${report.domain}`} />
          </Section>
          {groups.goLive.length === 0 ? null : (
            <Section
              title="At go-live"
              headingLevel={3}
              surface="plain"
              description="MX and the protocol records are published only after the security gate, so they stay pending until then."
            >
              <DnsChecklist rows={groups.goLive} compact label={`Records published at go-live for ${report.domain}`} />
            </Section>
          )}
        </>
      )}
      <p className="pr-wizard-note">
        Come back to{' '}
        <Link asChild variant="inline">
          <RouterLink to="/admin/dns">DNS &amp; DKIM</RouterLink>
        </Link>{' '}
        at any time: it has every record, including the address checks.
      </p>
      <FormActions align="start">
        <Button variant="primary" loading={busy} onClick={onNext}>
          Continue
        </Button>
      </FormActions>
    </Section>
  );
}

function MailboxStep({ view, busy, onSubmit }: { view: WizardView; busy: boolean; onSubmit: (localPart: string) => void }) {
  // No 'postmaster' default: the api keeps postmaster@ as an alias of the admin (PST-REQ-186), so
  // suggesting it as the operator's own mailbox would only earn a 409 address_taken.
  const initial = (view.mailbox ?? view.addresses[0] ?? '').split('@')[0] ?? '';
  const [localPart, setLocalPart] = useState(initial);
  const help = view.addresses.length === 0 ? undefined : `Your addresses at ${view.domain ?? 'this domain'}: ${view.addresses.join(', ')}`;
  return (
    <Section title="Mailbox" description="The address the test is sent from. Use your own, or add another address to your account.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(localPart);
        }}
      >
        <Stack gap="16">
          <FormField label="Address" width="lg" {...(help === undefined ? {} : { help })}>
            <Input appearance="filled"
              name="localPart"
              required
              autoComplete="off"
              spellCheck={false}
              value={localPart}
              trailing={<span>@{view.domain}</span>}
              onChange={(e) => {
                setLocalPart(e.target.value);
              }}
            />
          </FormField>
          <FormActions align="start">
            <Button type="submit" variant="primary" loading={busy}>
              Use this address
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Section>
  );
}

function TestStep({
  view,
  busy,
  onSent,
  onError,
  onFinish,
  onGoToMail,
}: {
  view: WizardView;
  busy: boolean;
  onSent: (outboundId: string) => Promise<void>;
  onError: (message: string) => void;
  onFinish: () => void;
  onGoToMail: () => void;
}) {
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [delivery, setDelivery] = useState<DeliveryView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outboundId = view.test?.outboundId ?? null;

  // Poll the delivery-attempts API until every recipient has settled.
  useEffect(() => {
    if (outboundId === null) return undefined;
    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const v = await api.delivery(outboundId);
        if (stopped) return;
        setDelivery(v);
        if (v.recipients.every((r) => settled(r.state))) return;
      } catch {
        // Keep polling: the timeline is read-only and the next answer will do.
      }
      if (!stopped) timer.current = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [outboundId]);

  const send = (e: SyntheticEvent) => {
    e.preventDefault();
    if (view.mailbox === null) return;
    setSending(true);
    api
      .send({
        from: view.mailbox,
        to: [to.trim()],
        cc: [],
        bcc: [],
        subject: 'Postroom test message',
        text: `This is the test message from Postroom's setup wizard, sent from ${view.mailbox}.\n\nIf it arrived, outbound mail works: it was DKIM-signed and delivered directly by Postroom.\n`,
        inReplyTo: null,
        references: [],
        forwardOf: null,
        draftId: null,
      })
      .then((sent) => onSent(sent.outboundId))
      .catch((caught: unknown) => {
        onError(explain(caught));
      })
      .finally(() => {
        setSending(false);
      });
  };

  return (
    <Section title="Test message" description="Send a message to an address somewhere else (not at your own domain), then watch it leave.">
      {view.mailbox === null ? (
        <Alert tone="warning">Choose the mailbox first.</Alert>
      ) : (
        <form onSubmit={send}>
          <Stack gap="16">
            <FormField label="Send a test to" width="lg" help={`From ${view.mailbox}, through the same submission path as any other message.`}>
              <Input appearance="filled"
                name="to"
                type="email"
                required
                autoComplete="email"
                value={to}
                onChange={(ev) => {
                  setTo(ev.target.value);
                }}
              />
            </FormField>
            <FormActions align="start">
              <Button type="submit" variant={outboundId === null ? 'primary' : 'secondary'} loading={sending}>
                {outboundId === null ? 'Send test' : 'Send another test'}
              </Button>
            </FormActions>
          </Stack>
        </form>
      )}

      {outboundId === null ? null : (
        <Section title="Delivery timeline" headingLevel={3} surface="plain">
          {delivery === null ? (
            <Skeleton variant="text" lines={3} />
          ) : (
            <Stack gap="16">
              {delivery.recipients.map((r) => (
                <Stack gap="8" key={r.id}>
                  <div className="pr-timeline__recipient">
                    <span>{r.address}</span>
                    <StatusDot size="sm" tone={recipientTone(r.state)}>
                      {recipientWord(r.state)}
                    </StatusDot>
                  </div>
                  <ol className="pr-timeline" aria-label={`Delivery timeline for ${r.address}`}>
                    {timelineOf(delivery, r).map((ev, i) => (
                      <li key={`${String(i)}:${ev.at}`} className="pr-timeline__event">
                        <time dateTime={ev.at} className="pr-timeline__time" title={new Date(ev.at).toLocaleString()}>
                          {new Date(ev.at).toLocaleTimeString()}
                        </time>{' '}
                        <span>{ev.title}</span>
                        {ev.detail === null ? null : <code className="pr-timeline__detail">{ev.detail}</code>}
                      </li>
                    ))}
                  </ol>
                </Stack>
              ))}
            </Stack>
          )}
        </Section>
      )}

      {view.completed ? (
        <Alert tone="success" title="Postroom is set up">
          The test left with its timeline above. The DNS checker stays under Admin console → DNS &amp; DKIM.
        </Alert>
      ) : null}
      <FormActions align="start">
        {view.completed ? (
          <Button variant="primary" onClick={onGoToMail}>
            Go to mail
          </Button>
        ) : (
          <Button variant="primary" disabled={outboundId === null} loading={busy} onClick={onFinish}>
            Finish setup
          </Button>
        )}
      </FormActions>
    </Section>
  );
}
