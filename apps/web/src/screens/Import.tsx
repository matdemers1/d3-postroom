import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Page,
  PageHeader,
  Section,
  Select,
  Stack,
  Table,
  Textarea,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, api, describeError, importApi, type ImportFolderStatus, type ImportStatus, type StartImportInput } from '../api';
import { Loading, LoadFailed } from './states';
import { IMPORT_PRESETS, presetById, presetForAddress, presetForHost } from './import/presets';

const ACTIVE = new Set(['pending', 'running']);
const POLL_MS = 2_000;

const STATUS_LABEL: Record<ImportStatus['status'], string> = {
  pending: 'Waiting to start',
  running: 'Importing',
  done: 'Finished',
  failed: 'Failed',
  cancelled: 'Canceled',
};

function importError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'import_active') return 'An import is already running for this account.';
    if (error.code === 'invalid_request') return 'Check the server, port, username and fingerprint.';
    if (error.code === 'kek_not_configured') return 'This server cannot hold the source password safely yet: POSTROOM_KEK is not set.';
  }
  return describeError(error);
}

/** "12 of 40", with duplicates when there were any. */
function folderCount(f: Pick<ImportFolderStatus, 'imported' | 'duplicates' | 'total'>): string {
  const handled = f.imported + f.duplicates;
  return `${String(handled)} of ${String(f.total)}${f.duplicates > 0 ? ` (${String(f.duplicates)} already here)` : ''}`;
}

/**
 * Import mail from another IMAP server (PST-REQ-152): folders land in folders of the same name,
 * Sent/Drafts/Trash/Junk/Archive in ours, with their flags and dates. An interrupted import resumes
 * where it stopped and never files a message twice. The source password is kept encrypted only
 * until the import ends.
 */
export function Import() {
  const [current, setCurrent] = useState<ImportStatus | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [folders, setFolders] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCurrent((await importApi.latest()).import);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = current !== null && current !== undefined && ACTIVE.has(current.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [active, load]);

  const input = (): StartImportInput => {
    const list = folders
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f !== '');
    return {
      host: host.trim(),
      port: Number(port),
      username: username.trim(),
      password,
      ...(fingerprint.trim() === '' ? {} : { trustFingerprint: fingerprint.trim() }),
      ...(list.length === 0 ? {} : { folders: list }),
    };
  };

  const choosePreset = (id: string) => {
    const chosen = presetById(id);
    if (chosen === undefined) return;
    setHost(chosen.host);
    setPort(chosen.port);
  };

  /** A known provider's address picks its preset; any other address leaves the server as it is. */
  const changeUsername = (value: string) => {
    setUsername(value);
    const match = presetForAddress(value);
    if (match !== undefined) choosePreset(match.id);
  };

  const preset = presetForHost(host);

  const start = async (): Promise<void> => {
    try {
      const started = await importApi.start(input());
      setCurrent(started);
      setPassword('');
      setCode('');
      setNotice('Import started. You can leave this page; it carries on.');
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'step_up_required') {
        setCode('');
        setCodeError('That code has expired. Enter a fresh one.');
        return;
      }
      setFormError(importError(caught));
    }
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    setCodeError(null);
    setNotice(null);
    const port0 = Number(port);
    if (code.trim() === '') {
      setCodeError('Enter the code from your authenticator.');
      return;
    }
    if (host.trim() === '' || username.trim() === '' || password === '') {
      setFormError('Enter the server, your username there, and its password.');
      return;
    }
    if (!Number.isInteger(port0) || port0 < 1 || port0 > 65_535) {
      setFormError('The port is a number from 1 to 65535 (usually 993).');
      return;
    }
    setBusy(true);
    api
      .stepUp(code)
      .then(
        () => start(),
        (caught: unknown) => {
          setCode('');
          setCodeError(describeError(caught));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  const cancel = (id: string) => {
    setNotice(null);
    importApi
      .cancel(id)
      .then((next) => {
        setCurrent(next);
        setNotice(next.status === 'cancelled' ? 'Import canceled.' : 'Stopping after the current message. What is already imported stays.');
      })
      .catch((caught: unknown) => {
        setNotice(importError(caught));
      });
  };

  const columns: TableColumn<ImportFolderStatus>[] = [
    { key: 'name', header: 'Folder', cell: (f) => f.name },
    { key: 'target', header: 'Into', cell: (f) => f.target },
    { key: 'count', header: 'Messages', cell: (f) => folderCount(f) },
    { key: 'done', header: 'State', cell: (f) => (f.done ? <Badge size="sm">Done</Badge> : null) },
  ];

  const renderCurrent = (imp: ImportStatus) => {
    const handled = imp.totals.imported + imp.totals.duplicates;
    const max = Math.max(imp.totals.total, handled, 1);
    return (
      <Section title={`From ${imp.username} at ${imp.host}`} description={STATUS_LABEL[imp.status]}>
        <Stack gap="16">
          {imp.status === 'failed' && imp.error !== null ? (
            <Alert tone="danger" title="The import stopped">
              {imp.error}
            </Alert>
          ) : null}
          {imp.status !== 'failed' && ACTIVE.has(imp.status) && imp.error !== null ? (
            <Alert tone="warning" title="Interrupted — it will resume">
              {imp.error}
            </Alert>
          ) : null}
          <FormField label="Progress" help={`${folderCount(imp.totals)} messages, ${String(imp.totals.foldersDone)} of ${String(imp.totals.folders)} folders done`}>
            <progress max={max} value={handled} aria-valuetext={`${String(handled)} of ${String(imp.totals.total)} messages`}>
              {`${String(handled)} of ${String(imp.totals.total)}`}
            </progress>
          </FormField>
          {imp.folders.length === 0 ? null : (
            <Table caption="Folders" captionHidden columns={columns} rows={imp.folders} rowKey={(f) => `${f.name}\u0000${f.target}`} />
          )}
          {ACTIVE.has(imp.status) ? (
            <FormActions>
              <Button
                variant="danger"
                disabled={imp.cancelRequested}
                onClick={() => {
                  cancel(imp.id);
                }}
              >
                {imp.cancelRequested ? 'Stopping…' : 'Cancel import'}
              </Button>
            </FormActions>
          ) : null}
        </Stack>
      </Section>
    );
  };

  return (
    // PST-T-15.6: the settings grid — a 680px column of Section cards, each field sized to its value.
    <Page width="narrow">
      <PageHeader title="Import mail" description="Copy folders from another IMAP server into this account. Nothing is deleted there." />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      {loadError !== null ? (
        <LoadFailed error={loadError} what="your import" onRetry={() => void load()} />
      ) : current === undefined ? (
        <Loading label="Loading your import" />
      ) : current === null ? (
        <EmptyState kind="empty" heading="No imports yet" headingLevel={2} size="inline">
          Start one below: Postroom copies each folder in, and this page follows it as it runs.
        </EmptyState>
      ) : (
        renderCurrent(current)
      )}

      {active ? null : (
        <Section title="Start an import" description="Postroom connects over TLS and keeps the password encrypted only until the import ends.">
          <form onSubmit={submit} noValidate>
            <Stack gap="16">
              {formError === null ? null : (
                <Alert tone="danger" dynamic>
                  {formError}
                </Alert>
              )}
              {/* PST-DA-046: the second factor is asked first, with the form, not after it. */}
              <FormField
                label="Authentication code"
                width="sm"
                help="From your authenticator app. Starting an import needs a fresh code."
                {...(codeError === null ? {} : { error: codeError })}
              >
                <Input appearance="filled"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]*"
                  required
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                  }}
                />
              </FormField>
              <FormField label="Provider" width="lg" help="Fills in the server and port. Pick Other for any IMAP server.">
                <Select appearance="filled"
                  name="provider"
                  options={IMPORT_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                  value={presetForHost(host).id}
                  onValueChange={choosePreset}
                />
              </FormField>
              <FormField label="Email address or username" width="lg" help="On the other server. A Gmail, iCloud, Outlook or Fastmail address picks its provider.">
                <Input appearance="filled"
                  name="username"
                  autoComplete="off"
                  required
                  value={username}
                  onChange={(e) => {
                    changeUsername(e.target.value);
                  }}
                />
              </FormField>
              <FormField
                label="Password"
                width="lg"
                help={preset.passwordHint ?? 'Its password or app password on that server. Deleted when the import ends.'}
              >
                <Input appearance="filled"
                  name="password"
                  type="password"
                  autoComplete="off"
                  required
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                  }}
                />
              </FormField>
              <FormField label="Server" width="lg" help="e.g. imap.example.org">
                <Input appearance="filled"
                  name="host"
                  autoComplete="off"
                  required
                  value={host}
                  onChange={(e) => {
                    setHost(e.target.value);
                  }}
                />
              </FormField>
              <FormField label="Port" width="xs" help="993 for IMAP over TLS">
                <Input appearance="filled"
                  name="port"
                  inputMode="numeric"
                  required
                  value={port}
                  onChange={(e) => {
                    setPort(e.target.value);
                  }}
                />
              </FormField>
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={advancedOpen}
                  aria-controls="import-advanced"
                  onClick={() => {
                    setAdvancedOpen((open) => !open);
                  }}
                >
                  Advanced
                </Button>
              </div>
              {advancedOpen ? (
                <Stack gap="16" id="import-advanced">
                  <FormField
                    label="Trust this certificate (optional)"
                    width="lg"
                    help="Only for your own server with a self-signed certificate: its SHA-256 fingerprint, from openssl x509 -noout -fingerprint -sha256 on that server."
                  >
                    <Input appearance="filled"
                      name="trustFingerprint"
                      autoComplete="off"
                      spellCheck={false}
                      value={fingerprint}
                      onChange={(e) => {
                        setFingerprint(e.target.value);
                      }}
                    />
                  </FormField>
                  <FormField label="Only these folders (optional)" width="lg" help="One per line. Leave empty for every folder.">
                    <Textarea appearance="filled"
                      name="folders"
                      rows={3}
                      value={folders}
                      onChange={(e) => {
                        setFolders(e.target.value);
                      }}
                    />
                  </FormField>
                </Stack>
              ) : null}
              <FormActions>
                <Button type="submit" variant="primary" loading={busy}>
                  Start import
                </Button>
              </FormActions>
            </Stack>
          </form>
        </Section>
      )}
    </Page>
  );
}
