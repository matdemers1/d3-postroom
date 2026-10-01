import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Cluster,
  DataList,
  DataListRow,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  Section,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import { api, describeError, type AppPassword, type AppPasswordScope } from '../api';
import { RelativeTime } from '../components/RelativeTime';
import { DEFAULT_SCOPES, passwordFacts, scopeSummary, type PasswordFact } from './app-passwords-format';
import { ConnectionStatus } from './device/FirstUse';
import { SECURITY_DESCRIPTION } from './device/security';
import { ServerSettings } from './device/ServerSettings';
import { Loading, LoadFailed } from './states';
import { SubNav } from './SubNav';
import './device/security.css';

const SCOPES: { scope: AppPasswordScope; label: string }[] = [
  { scope: 'imap', label: 'Read mail (IMAP)' },
  { scope: 'smtp', label: 'Send mail (SMTP)' },
  { scope: 'dav', label: 'Calendars and contacts (DAV)' },
  { scope: 'sieve', label: 'Rules (ManageSieve)' },
];

/** One fact on a row's description line, its time drawn by RelativeTime (the full time on hover). */
function Fact({ fact }: { fact: PasswordFact }) {
  if (fact.kind === 'never-used') return <>Never used</>;
  if (fact.kind === 'created') {
    return (
      <>
        created <RelativeTime iso={fact.at} />
      </>
    );
  }
  return (
    <>
      Used <RelativeTime iso={fact.at} />
      {fact.ip === null ? null : ` from ${fact.ip}`}
    </>
  );
}

function PasswordDescription({ password }: { password: AppPassword }) {
  return (
    <>
      {passwordFacts(password).map((fact, i) => (
        <span key={fact.kind}>
          {i === 0 ? null : ' · '}
          <Fact fact={fact} />
        </span>
      ))}
    </>
  );
}

/**
 * App passwords (PST-REQ-027): mail clients sign in with one of these, never the account password.
 * Each is scoped, shown exactly once when created, and revoking it locks its client out at the next
 * connection.
 */
export function AppPasswords() {
  const [rows, setRows] = useState<AppPassword[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // PST-T-16.23: the card's New button unmounts while the form is open; folding the form away
  // (Cancel, or done) hands focus back to it, as Account's Change password does.
  const newButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!creating && returnFocus.current) {
      returnFocus.current = false;
      newButton.current?.focus();
    }
  }, [creating]);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<AppPasswordScope[]>([...DEFAULT_SCOPES]);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<{ id: string; label: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<AppPassword | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows((await api.appPasswords()).appPasswords);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (scope: AppPasswordScope, on: boolean) => {
    setScopes((current) => (on ? [...current.filter((s) => s !== scope), scope] : current.filter((s) => s !== scope)));
  };

  // PST-T-16.23: the form is not in the DOM until "New app password" is pressed, and closes on create.
  const closeForm = () => {
    returnFocus.current = true;
    setCreating(false);
    setLabel('');
    setScopes([...DEFAULT_SCOPES]);
    setFormError(null);
  };

  const create = (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    setNotice(null);
    if (label.trim() === '') {
      setFormError('Name the device or app this password is for.');
      return;
    }
    if (scopes.length === 0) {
      setFormError('Choose at least one thing this password may do.');
      return;
    }
    setBusy(true);
    api
      .createAppPassword({ label: label.trim(), scopes })
      .then(async (created) => {
        setRevealed({ id: created.id, label: created.label, password: created.password });
        setCopied(false);
        closeForm();
        await load();
      })
      .catch((caught: unknown) => {
        setFormError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const revoke = (row: AppPassword) => {
    setNotice(null);
    setRevoking(true);
    api
      .revokeAppPassword(row.id)
      .then(async () => {
        setConfirming(null);
        setNotice(`Revoked "${row.label}". Its client is signed out at its next connection.`);
        await load();
      })
      .catch((caught: unknown) => {
        setNotice(describeError(caught));
      })
      .finally(() => {
        setRevoking(false);
      });
  };

  const copy = (password: string) => {
    navigator.clipboard
      .writeText(password)
      .then(() => {
        setCopied(true);
      })
      .catch(() => {
        setCopied(false);
      });
  };

  return (
    // PST-T-15.6: the settings grid — a 680px column of Section cards; the passwords are rows.
    // PST-T-17.9: one constant header for all of Security & devices, then its tabs, then one card
    // that holds everything on this tab: its New button, the create form, the one-time reveal, the list.
    <Page width="narrow" align="center">
      <PageHeader title="Security & devices" description={SECURITY_DESCRIPTION} />
      <SubNav />
      <Section
        title="App passwords"
        description="Mail apps sign in with one of these, never your account password."
        actions={
          creating ? null : (
            <Button
              ref={newButton}
              size="sm"
              variant="primary"
              onClick={() => {
                setNotice(null);
                setCreating(true);
              }}
            >
              New app password
            </Button>
          )
        }
      >
        {notice === null ? null : (
          <Alert tone="info" dynamic>
            {notice}
          </Alert>
        )}

        {revealed === null ? null : (
          <div className="pr-sec-panel" role="group" aria-labelledby="app-password-reveal">
            <Stack gap="12">
              <div>
                <h3 id="app-password-reveal" className="pr-sec-panel__title">{`Password for ${revealed.label}`}</h3>
                <p className="pr-sec-panel__desc">Copy it into the app now. You won’t see this again.</p>
              </div>
              <Alert tone="warning" title="Shown once">
                Postroom keeps only a hash. If you lose it, revoke it and create another.
              </Alert>
              <FormField label="App password" width="lg">
                <Textarea appearance="filled" mono readOnly rows={1} value={revealed.password} onFocus={(e) => { e.currentTarget.select(); }} />
              </FormField>
              <Cluster>
                <Button
                  variant="primary"
                  onClick={() => {
                    copy(revealed.password);
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button
                  onClick={() => {
                    setRevealed(null);
                  }}
                >
                  Done
                </Button>
              </Cluster>
              <ConnectionStatus key={revealed.id} watch={{ kind: 'password', id: revealed.id }} waiting="Waiting for the app to sign in." />
              {/* PST-T-16.16: the same settings block as Connect a device › Other, beside the password. */}
              <ServerSettings />
            </Stack>
          </div>
        )}

        {!creating ? null : (
          <form className="pr-sec-panel" aria-labelledby="app-password-new" onSubmit={create}>
            <Stack gap="16">
              <h3 id="app-password-new" className="pr-sec-panel__title">
                New app password
              </h3>
              <FormField label="Name" width="lg" help="The device or app it is for, e.g. iPhone Mail." {...(formError === null ? {} : { error: formError })}>
                <Input appearance="filled"
                  autoFocus
                  name="label"
                  maxLength={100}
                  required
                  value={label}
                  onChange={(e) => {
                    setLabel(e.target.value);
                  }}
                />
              </FormField>
              <FormField label="Permissions" as="group">
                <Stack gap="8">
                  {SCOPES.map(({ scope, label: scopeLabel }) => (
                    <Checkbox
                      key={scope}
                      name="scopes"
                      value={scope}
                      label={scopeLabel}
                      checked={scopes.includes(scope)}
                      onCheckedChange={(checked) => {
                        toggle(scope, checked === true);
                      }}
                    />
                  ))}
                </Stack>
              </FormField>
              <FormActions>
                <Button type="button" onClick={closeForm}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" loading={busy}>
                  Create password
                </Button>
              </FormActions>
            </Stack>
          </form>
        )}

        {loadError !== null ? (
          <LoadFailed error={loadError} what="app passwords" onRetry={() => void load()} headingLevel={3} size="row" />
        ) : rows === null ? (
          <Loading label="Loading app passwords" height={96} />
        ) : (
          // No header over nothing (PST-T-14.11): the empty state says what goes here.
          <DataList
            aria-label="Your app passwords"
            empty={
              <EmptyState kind="empty" heading="No app passwords yet" headingLevel={3} size="row">
                Make one for each mail, calendar or contacts app you sign in to.
              </EmptyState>
            }
          >
            {rows.map((p) => {
              const scope = scopeSummary(p.scopes);
              return (
                <DataListRow
                  key={p.id}
                  title={p.label}
                  description={<PasswordDescription password={p} />}
                  meta={scope === null ? null : <Badge size="sm">{scope}</Badge>}
                  actions={
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`Revoke ${p.label}`}
                      onClick={() => {
                        setConfirming(p);
                      }}
                    >
                      Revoke
                    </Button>
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
        title="Revoke this app password?"
        description={confirming === null ? '' : `"${confirming.label}" is signed out at its next connection. This cannot be undone.`}
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button
              type="button"
              variant="danger"
              loading={revoking}
              onClick={() => {
                if (confirming !== null) revoke(confirming);
              }}
            >
              Revoke
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </Page>
  );
}
