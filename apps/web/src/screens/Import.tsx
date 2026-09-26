import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
  Table,
  Textarea,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, api, describeError, importApi, type ImportFolderStatus, type ImportStatus, type StartImportInput } from '../api';

const ACTIVE = new Set(['pending', 'running']);
const POLL_MS = 2_000;

const STATUS_LABEL: Record<ImportStatus['status'], string> = {
  pending: 'Waiting to start',
  running: 'Importing',
  done: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
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
  const [loadError, setLoadError] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [folders, setFolders] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCurrent((await importApi.latest()).import);
      setLoadError(false);
    } catch {
      setLoadError(true);
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

  const start = async (): Promise<void> => {
    setFormError(null);
    setNotice(null);
    try {
      const started = await importApi.start(input());
      setCurrent(started);
      setStepUpOpen(false);
      setPassword('');
      setNotice('Import started. You can leave this page; it carries on.');
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'step_up_required') {
        setCode('');
        setCodeError(null);
        setStepUpOpen(true);
        return;
      }
      setStepUpOpen(false);
      setFormError(importError(caught));
    }
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const port0 = Number(port);
    if (host.trim() === '' || username.trim() === '' || password === '') {
      setFormError('Enter the server, your username there, and its password.');
      return;
    }
    if (!Number.isInteger(port0) || port0 < 1 || port0 > 65_535) {
      setFormError('The port is a number from 1 to 65535 (usually 993).');
      return;
    }
    setBusy(true);
    void start().finally(() => {
      setBusy(false);
    });
  };

  const confirmStepUp = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setCodeError(null);
    api
      .stepUp(code)
      .then(() => start())
      .catch((caught: unknown) => {
        setCode('');
        setCodeError(describeError(caught));
      })
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
        setNotice(next.status === 'cancelled' ? 'Import cancelled.' : 'Stopping after the current message. What is already imported stays.');
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
    <Page>
      <PageHeader title="Import mail" description="Copy folders from another IMAP server into this account. Nothing is deleted there." />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      {loadError ? (
        <EmptyState kind="error" heading="Could not load your import" headingLevel={2} action={<Button onClick={() => void load()}>Try again</Button>}>
          The server did not answer.
        </EmptyState>
      ) : current === undefined ? (
        <Skeleton variant="block" />
      ) : current === null ? null : (
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
              <FormField label="Server" help="e.g. imap.example.org">
                <Input
                  name="host"
                  autoComplete="off"
                  required
                  value={host}
                  onChange={(e) => {
                    setHost(e.target.value);
                  }}
                />
              </FormField>
              <FormField label="Port" help="993 for IMAP over TLS">
                <Input
                  name="port"
                  inputMode="numeric"
                  required
                  value={port}
                  onChange={(e) => {
                    setPort(e.target.value);
                  }}
                />
              </FormField>
              <FormField label="Username">
                <Input
                  name="username"
                  autoComplete="off"
                  required
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                  }}
                />
              </FormField>
              <FormField label="Password" help="Its password or app password on that server. Deleted when the import ends.">
                <Input
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
              <FormField
                label="Trust this certificate (optional)"
                help="Only for your own server with a self-signed certificate: its SHA-256 fingerprint, from openssl x509 -noout -fingerprint -sha256 on that server."
              >
                <Input
                  name="trustFingerprint"
                  autoComplete="off"
                  spellCheck={false}
                  value={fingerprint}
                  onChange={(e) => {
                    setFingerprint(e.target.value);
                  }}
                />
              </FormField>
              <FormField label="Only these folders (optional)" help="One per line. Leave empty for every folder.">
                <Textarea
                  name="folders"
                  rows={3}
                  value={folders}
                  onChange={(e) => {
                    setFolders(e.target.value);
                  }}
                />
              </FormField>
              <FormActions>
                <Button type="submit" variant="primary" loading={busy && !stepUpOpen}>
                  Start import
                </Button>
              </FormActions>
            </Stack>
          </form>
        </Section>
      )}

      <Modal
        open={stepUpOpen}
        onOpenChange={(open) => {
          if (!open) setStepUpOpen(false);
        }}
        title="Confirm it is you"
        description="Starting an import needs a code from your authenticator; it stays valid for five minutes."
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="submit" form="import-step-up" variant="primary" loading={busy}>
              Verify and start
            </Button>
          </>
        }
      >
        <form id="import-step-up" onSubmit={confirmStepUp}>
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
