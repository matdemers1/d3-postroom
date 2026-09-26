import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Cluster,
  DescriptionItem,
  DescriptionList,
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
} from '@d3cloud/ui';
import {
  ApiError,
  api,
  describeError,
  dnsSummary,
  settled,
  timelineOf,
  WIZARD_CHANGED_EVENT,
  WIZARD_STEPS,
  wizardReachable,
  type DeliveryView,
  type WizardStep,
  type WizardView,
} from '../api';
import { CopyButton, DnsTable, DnsValue, ResolverNote, useDnsReport } from './AdminDns';

const mutedStyle = { color: 'var(--color-fg-muted)' } as const;
const POLL_MS = 2_000;

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
      <Page>
        <PageHeader title="Set up mail" />
        <EmptyState kind="error" heading="Could not load the setup wizard" headingLevel={2} action={<Button onClick={() => void load()}>Try again</Button>}>
          The server did not answer.
        </EmptyState>
      </Page>
    );
  }
  if (view === null) {
    return (
      <Page>
        <PageHeader title="Set up mail" />
        <Skeleton variant="block" />
      </Page>
    );
  }

  const index = WIZARD_STEPS.findIndex((s) => s.step === current);
  const description = view.completed ? 'Postroom is set up.' : index === -1 ? 'All steps done.' : `Step ${String(index + 1)} of ${String(WIZARD_STEPS.length)}: ${WIZARD_STEPS[index]?.label ?? ''}`;

  return (
    <Page>
      <PageHeader title="Set up mail" description={description} />
      <nav aria-label="Setup steps">
        <Cluster gap="8" as="ol">
          {WIZARD_STEPS.map((s, i) => (
            <li key={s.step}>
              <Button
                size="sm"
                variant={s.step === current ? 'primary' : 'ghost'}
                disabled={!wizardReachable(view, s.step)}
                aria-current={s.step === current ? 'step' : undefined}
                onClick={() => {
                  setError(null);
                  setCurrent(s.step);
                }}
              >
                {`${String(i + 1)}. ${s.label}`}
              </Button>
            </li>
          ))}
        </Cluster>
      </nav>

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
          <FormField label="Domain" help="Only a domain you control. A no-reply subdomain belongs to Cloudflare Email Service and is refused.">
            <Input
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
          <FormActions>
            <Button type="submit" variant="primary" loading={busy}>
              Save domain
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Section>
  );
}

function DkimStep({ view, busy, onGenerate, onNext }: { view: WizardView; busy: boolean; onGenerate: () => void; onNext: () => void }) {
  return (
    <Section
      title="DKIM keys"
      description="Every message Postroom sends is signed twice: Ed25519 and RSA-2048. The private keys are sealed under the server’s key and never leave it; publish these two TXT records."
    >
      <Stack gap="16">
        {view.dkim.length === 0 ? (
          <p style={mutedStyle}>No keys yet for {view.domain}.</p>
        ) : (
          <DescriptionList>
            {view.dkim.map((k) => (
              <DescriptionItem key={k.selector} term={`${k.algorithm === 'rsa-sha256' ? 'RSA-2048' : 'Ed25519'} — ${k.selector}`}>
                <Stack gap="8">
                  <span>
                    TXT at <DnsValue>{k.dnsName}</DnsValue>
                  </span>
                  <Cluster gap="8">
                    <CopyButton value={k.dnsName} label={`${k.selector} record name`} />
                    <CopyButton value={k.dnsRecord} label={`${k.selector} record value`} />
                  </Cluster>
                  <DnsValue>{k.dnsRecord}</DnsValue>
                </Stack>
              </DescriptionItem>
            ))}
          </DescriptionList>
        )}
        <FormActions>
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
      </Stack>
    </Section>
  );
}

function DnsStep({ domain, busy, onNext }: { domain: string; busy: boolean; onNext: () => void }) {
  const { report, failed, checking, check } = useDnsReport(domain);
  return (
    <Section
      title="DNS records"
      description="Publish the expected values at your DNS host, then re-check. MX and the protocol records are published only after the security gate, so they stay pending until go-live."
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
      <Stack gap="16">
        {failed ? (
          <Alert tone="danger">The DNS check did not answer. Try again.</Alert>
        ) : report === null ? (
          <Skeleton variant="block" />
        ) : (
          <>
            <ResolverNote report={report} />
            <p aria-live="polite">{dnsSummary(report.summary)}</p>
            <DnsTable report={report} />
          </>
        )}
        <p style={mutedStyle}>
          You can continue while records are pending and come back to <Link asChild variant="inline"><RouterLink to="/admin/dns">Admin → DNS records</RouterLink></Link> at any time.
        </p>
        <FormActions>
          <Button variant="primary" loading={busy} onClick={onNext}>
            Continue
          </Button>
        </FormActions>
      </Stack>
    </Section>
  );
}

function MailboxStep({ view, busy, onSubmit }: { view: WizardView; busy: boolean; onSubmit: (localPart: string) => void }) {
  const initial = (view.mailbox ?? view.addresses[0] ?? 'postmaster').split('@')[0] ?? '';
  const [localPart, setLocalPart] = useState(initial);
  return (
    <Section title="Mailbox" description="The address the test is sent from. Use your own, or add another address to your account.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(localPart);
        }}
      >
        <Stack gap="16">
          {view.addresses.length === 0 ? null : <p style={mutedStyle}>Your addresses at {view.domain}: {view.addresses.join(', ')}</p>}
          <FormField label="Address">
            <Input
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
          <FormActions>
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
      <Stack gap="16">
        {view.mailbox === null ? (
          <Alert tone="warning">Choose the mailbox first.</Alert>
        ) : (
          <form onSubmit={send}>
            <Stack gap="16">
              <FormField label="Send a test to" help={`From ${view.mailbox}, through the same submission path as any other message.`}>
                <Input
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
              <FormActions>
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
                    <Cluster gap="8">
                      <strong>{r.address}</strong>
                      <Badge size="sm" tone={r.state === 'delivered' ? 'neutral' : r.state === 'bounced' || r.state === 'cancelled' ? 'danger' : 'attention'}>
                        {r.state}
                      </Badge>
                    </Cluster>
                    <ol aria-label={`Delivery timeline for ${r.address}`}>
                      {timelineOf(delivery, r).map((ev, i) => (
                        <li key={`${String(i)}:${ev.at}`}>
                          <Stack gap="2">
                            <span>
                              <time dateTime={ev.at} style={mutedStyle}>
                                {new Date(ev.at).toLocaleTimeString()}
                              </time>{' '}
                              {ev.title}
                            </span>
                            {ev.detail === null ? null : <DnsValue>{ev.detail}</DnsValue>}
                          </Stack>
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
            The test left with its timeline above. The DNS checker stays under Admin → DNS records.
          </Alert>
        ) : null}
        <FormActions>
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
      </Stack>
    </Section>
  );
}
