// Admin › Sign in with D3 Auth (PST-T-17.7; PST-REQ-201, PST-REQ-204, PST-ADR-014). One narrow
// column: the live status in the header, "Connect to D3 Auth" (issuer, client ID, a write-only
// secret, Test connection, Save behind step-up, Turn off behind a confirm), and "Register Postroom
// in D3 Auth" — the four steps, the three addresses with Copy, and the manifest ready to paste.
// Everything shown comes from GET /api/admin/auth/d3auth: the addresses are the server's own, never
// rebuilt here. Saving takes effect without a restart.
import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  FormActions,
  FormField,
  IconButton,
  Input,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  PasswordInput,
  Section,
  StatusDot,
  useToast,
} from '@d3cloud/ui';
import { describeError, d3authApi, type D3AuthConfig, type D3AuthTestResult } from '../../api';
import { Loading, LoadFailed } from '../../screens/states';
import {
  type D3AuthForm,
  type FieldErrors,
  fieldErrors,
  formFrom,
  manifestText,
  REGISTER_STEPS,
  SECRET_AGAIN_HELP,
  SECRET_NEW_HELP,
  secretNeeded,
  SECRET_SAVED_HELP,
  saveInput,
  statusLine,
  TURN_OFF_COPY,
} from './model';
import { useStepUp } from './step-up';
import '../admin.css';
import './d3auth.css';

export const SCREEN_TITLE = 'Sign in with D3 Auth';
export const SCREEN_DESCRIPTION = 'Let people sign in to Postroom with their D3 Auth account.';

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a1 1 0 0 1 1-1h10" />
    </svg>
  );
}

/** The header's description: the status as a StatusDot, why it is down, and where it comes from. */
export function D3AuthStatusLine({ config }: { config: D3AuthConfig }) {
  const line = statusLine(config);
  return (
    <span className="pr-d3a__status" data-status={config.status}>
      <StatusDot tone={line.tone}>{line.label}</StatusDot>
      {line.detail === null ? null : <span className="pr-d3a__detail">· {line.detail}</span>}
      {line.source === null ? null : <span>· {line.source}</span>}
    </span>
  );
}

/** What Test connection found, inline beside it. */
export function TestResult({ result }: { result: D3AuthTestResult }) {
  return result.ok ? (
    <span className="pr-d3a__result">
      <StatusDot tone="neutral" size="sm">
        Reached D3 Auth
      </StatusDot>
      {result.authorizationEndpoint === undefined ? null : <code className="pr-d3a__mono">{result.authorizationEndpoint}</code>}
    </span>
  ) : (
    <span className="pr-d3a__result">
      <StatusDot tone="danger" size="sm">
        Could not reach D3 Auth
      </StatusDot>
      <span className="pr-muted">{result.error ?? `Nothing answered at ${result.issuer}.`}</span>
    </span>
  );
}

export interface ConnectCardProps {
  config: D3AuthConfig;
  form: D3AuthForm;
  errors: FieldErrors;
  /** A refusal that names no field. */
  saveError: string | null;
  testResult: D3AuthTestResult | null;
  testing: boolean;
  saving: boolean;
  onChange: (form: D3AuthForm) => void;
  onTest: () => void;
  onSave: () => void;
  onCancel: () => void;
  onTurnOff: () => void;
}

export function ConnectCard(props: ConnectCardProps) {
  const { config, form, errors, saveError, testResult, testing, saving, onChange } = props;
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    props.onSave();
  };
  const err = (field: keyof D3AuthForm) => (errors[field] === undefined ? {} : { error: errors[field] });
  const needSecret = secretNeeded(config, form);
  return (
    <Section title="Connect to D3 Auth" description="The issuer and the client D3 Auth registered for Postroom. Saving takes effect at once.">
      <form className="pr-d3a__form" onSubmit={submit} aria-label="Connect to D3 Auth" noValidate>
        {saveError === null ? null : (
          <Alert tone="danger" title="Could not save" dynamic>
            {saveError}
          </Alert>
        )}
        <FormField label="Issuer" width="lg" help="D3 Auth’s address, for example https://auth.d3cloud.io." {...err('issuer')}>
          <Input
            appearance="filled"
            name="issuer"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required
            value={form.issuer}
            onChange={(e) => {
              onChange({ ...form, issuer: e.target.value });
            }}
          />
        </FormField>
        <FormField label="Client ID" width="md" {...err('clientId')}>
          <Input
            appearance="filled"
            name="clientId"
            autoComplete="off"
            spellCheck={false}
            required
            value={form.clientId}
            onChange={(e) => {
              onChange({ ...form, clientId: e.target.value });
            }}
          />
        </FormField>
        <FormField
          label="Client secret"
          width="md"
          help={needSecret === 'again' ? SECRET_AGAIN_HELP : needSecret === 'new' ? SECRET_NEW_HELP : SECRET_SAVED_HELP}
          optional={needSecret === null}
          {...err('clientSecret')}
        >
          <PasswordInput
            name="clientSecret"
            autoComplete="new-password"
            capsLockHint={false}
            required={needSecret !== null}
            value={form.clientSecret}
            onChange={(e) => {
              onChange({ ...form, clientSecret: e.target.value });
            }}
          />
        </FormField>
        <div className="pr-d3a__test">
          <Button type="button" variant="secondary" size="sm" loading={testing} onClick={props.onTest}>
            Test connection
          </Button>
          <div role="status" aria-live="polite" className="pr-d3a__test-out">
            {testResult === null ? null : <TestResult result={testResult} />}
          </div>
        </div>
        <FormActions
          className="pr-d3a__actions"
          leading={
            config.enabled ? (
              <Button type="button" variant="danger-ghost" onClick={props.onTurnOff}>
                Turn off
              </Button>
            ) : undefined
          }
        >
          <Button type="button" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            Save
          </Button>
        </FormActions>
      </form>
    </Section>
  );
}

function UriRow({ label, value, onCopy }: { label: string; value: string; onCopy: (value: string, what: string) => void }) {
  return (
    <div className="pr-d3a__uri">
      <dt>{label}</dt>
      <dd>
        <code className="pr-d3a__mono">{value}</code>
        <IconButton
          label={`Copy ${label.toLowerCase()}`}
          icon={<CopyIcon />}
          size="sm"
          onClick={() => {
            onCopy(value, label);
          }}
        />
      </dd>
    </div>
  );
}

export function RegisterCard({ config, onCopy }: { config: D3AuthConfig; onCopy: (value: string, what: string) => void }) {
  const manifest = manifestText(config.manifest);
  return (
    <Section title="Register Postroom in D3 Auth" description="Postroom’s own addresses, from this server’s configuration.">
      <ol className="pr-d3a__steps">
        {REGISTER_STEPS.map((step) => (
          <li key={step.title}>
            <strong>{step.title}</strong>
            <span className="pr-muted"> — {step.detail}</span>
          </li>
        ))}
      </ol>
      <dl className="pr-d3a__uris">
        <UriRow label="Redirect URI" value={config.redirectUri} onCopy={onCopy} />
        <UriRow label="Back-channel logout URI" value={config.backchannelLogoutUri} onCopy={onCopy} />
        <UriRow label="Post-logout redirect URI" value={config.postLogoutRedirectUri} onCopy={onCopy} />
      </dl>
      <div className="pr-d3a__manifest-head">
        <h3 className="pr-d3a__h3">Manifest</h3>
        <Button
          size="sm"
          variant="secondary"
          icon={<CopyIcon />}
          aria-label="Copy manifest"
          onClick={() => {
            onCopy(manifest, 'Manifest');
          }}
        >
          Copy
        </Button>
      </div>
      <pre className="pr-d3a__manifest" aria-label="D3 Auth manifest">
        <code>{manifest}</code>
      </pre>
    </Section>
  );
}

export function AdminD3Auth() {
  const [config, setConfig] = useState<D3AuthConfig | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [form, setForm] = useState<D3AuthForm>(formFrom(null));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<D3AuthTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const toast = useToast();
  const { withStepUp, prompt } = useStepUp('Changing how people sign in is a security setting');

  const show = useCallback((next: D3AuthConfig) => {
    setConfig(next);
    setForm(formFrom(next));
    setErrors({});
    setSaveError(null);
  }, []);

  const load = useCallback(async () => {
    try {
      show(await d3authApi.config());
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCopy = (value: string, what: string) => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        toast.show({ message: `Copied · ${what}` });
      })
      .catch(() => {
        toast.show({ message: 'Could not copy. Select the text and copy it instead.' });
      });
  };

  const onTest = () => {
    setTesting(true);
    setTestResult(null);
    const issuer = form.issuer.trim();
    d3authApi
      .test(issuer === '' ? undefined : issuer)
      .then(setTestResult)
      .catch((caught: unknown) => {
        setTestResult({ ok: false, issuer, error: describeError(caught) });
      })
      .finally(() => {
        setTesting(false);
      });
  };

  const onSave = () => {
    setSaving(true);
    setErrors({});
    setSaveError(null);
    setNotice(null);
    withStepUp(() => d3authApi.save(saveInput(form)))
      .then((saved) => {
        if (saved === null) return;
        if (saved.signedOut === true) {
          window.location.assign('/signin');
          return;
        }
        show(saved);
        setNotice(saved.status === 'available' ? 'Saved. Sign in with D3 Auth is available.' : 'Saved.');
      })
      .catch((caught: unknown) => {
        const fields = fieldErrors(caught);
        setErrors(fields);
        if (Object.keys(fields).length === 0) setSaveError(describeError(caught));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  /** Confirmed: the confirm closes first, so a step-up prompt never stacks on top of it. */
  const onTurnOff = () => {
    setConfirmOff(false);
    setNotice(null);
    withStepUp(() => d3authApi.turnOff())
      .then((off) => {
        if (off === null) return;
        if (off.signedOut === true) {
          window.location.assign('/signin');
          return;
        }
        show(off);
        setTestResult(null);
        setNotice('Sign in with D3 Auth is off.');
      })
      .catch((caught: unknown) => {
        setSaveError(describeError(caught));
      });
  };

  return (
    <Page width="narrow" className="pr-d3a">
      <PageHeader title={SCREEN_TITLE} description={config === null ? SCREEN_DESCRIPTION : <D3AuthStatusLine config={config} />} />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}
      {loadError !== null ? (
        <LoadFailed error={loadError} what="the D3 Auth settings" onRetry={() => void load()} />
      ) : config === null ? (
        <Loading label="Loading the D3 Auth settings" />
      ) : (
        <>
          <ConnectCard
            config={config}
            form={form}
            errors={errors}
            saveError={saveError}
            testResult={testResult}
            testing={testing}
            saving={saving}
            onChange={setForm}
            onTest={onTest}
            onSave={onSave}
            onCancel={() => {
              show(config);
              setTestResult(null);
            }}
            onTurnOff={() => {
              setConfirmOff(true);
            }}
          />
          <RegisterCard config={config} onCopy={onCopy} />
        </>
      )}

      <Modal
        open={confirmOff}
        onOpenChange={(open) => {
          if (!open) setConfirmOff(false);
        }}
        destructive
        title="Turn off Sign in with D3 Auth"
        description={TURN_OFF_COPY}
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="button" variant="danger" onClick={onTurnOff}>
              Turn off
            </Button>
          </>
        }
      />
      {prompt}
    </Page>
  );
}
