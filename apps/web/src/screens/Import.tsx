import '../settings/settings.css';
import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  DataList,
  DataListRow,
  FormActions,
  FormField,
  IconButton,
  Input,
  Page,
  PageHeader,
  Section,
  Select,
  SettingsRow,
  StatusDot,
  Table,
  Textarea,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, describeError, importApi, type ImportFolderStatus, type ImportStatus, type StartImportInput } from '../api';
import { useStepUp } from '../admin/sign-in/step-up';
import { ChevronIcon } from '../mail/icons';
import { PHONE_QUERY, useMediaQuery } from '../mail/useMedia';
import { Loading, LoadFailed } from './states';
import { IMPORT_PRESETS, presetById, presetForAddress, presetForHost } from './import/presets';
import { folderCount, folderState, importFormProblem, importState, importTitle, isActive } from './import/status';

const POLL_MS = 2_000;
const ADVANCED_ID = 'import-advanced';

function importError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'import_active') return 'An import is already running for this account.';
    if (error.code === 'invalid_request') return 'Check the server, port, username and fingerprint.';
    if (error.code === 'kek_not_configured') return 'This server cannot hold the source password safely yet: POSTROOM_KEK is not set.';
  }
  return describeError(error);
}

/** The latest import: its state in the head, progress, its folders, and Cancel while it runs. */
function ImportCard({ imp, phone, onCancel }: { imp: ImportStatus; phone: boolean; onCancel: (id: string) => void }) {
  const handled = imp.totals.imported + imp.totals.duplicates;
  const max = Math.max(imp.totals.total, handled, 1);
  const state = importState(imp);
  const active = isActive(imp);
  const columns: TableColumn<ImportFolderStatus>[] = [
    { key: 'name', header: 'Folder', cell: (f) => f.name },
    { key: 'target', header: 'Into', cell: (f) => f.target },
    { key: 'count', header: 'Messages', cell: (f) => folderCount(f) },
    {
      key: 'done',
      header: 'State',
      cell: (f) => (
        <StatusDot size="sm" tone={folderState(f, imp).tone}>
          {folderState(f, imp).label}
        </StatusDot>
      ),
    },
  ];
  return (
    <Section
      title={importTitle(imp)}
      description={`From ${imp.username} at ${imp.host}`}
      actions={
        <StatusDot size="sm" tone={state.tone}>
          {state.label}
        </StatusDot>
      }
    >
      {imp.status === 'failed' && imp.error !== null ? (
        <Alert tone="danger" title="The import stopped">
          {imp.error}
        </Alert>
      ) : null}
      {imp.status !== 'failed' && active && imp.error !== null ? (
        <Alert tone="warning" title="Interrupted — it will resume">
          {imp.error}
        </Alert>
      ) : null}
      <div className="pr-setform">
        <FormField label="Progress" help={`${folderCount(imp.totals)} messages, ${String(imp.totals.foldersDone)} of ${String(imp.totals.folders)} folders done`}>
          <progress max={max} value={handled} aria-valuetext={`${String(handled)} of ${String(imp.totals.total)} messages`}>
            {`${String(handled)} of ${String(imp.totals.total)}`}
          </progress>
        </FormField>
      </div>
      {imp.folders.length === 0 ? null : phone ? (
        <DataList aria-label="Folders">
          {imp.folders.map((f) => (
            <DataListRow
              key={`${f.name}\u0000${f.target}`}
              title={f.name}
              description={`Into ${f.target} · ${folderCount(f)}`}
              meta={
                <StatusDot size="sm" tone={folderState(f, imp).tone}>
                  {folderState(f, imp).label}
                </StatusDot>
              }
            />
          ))}
        </DataList>
      ) : (
        <Table caption="Folders" captionHidden columns={columns} rows={imp.folders} rowKey={(f) => `${f.name}\u0000${f.target}`} />
      )}
      {active ? (
        <FormActions className="pr-setform__actions">
          <Button
            variant="secondary"
            disabled={imp.cancelRequested}
            onClick={() => {
              onCancel(imp.id);
            }}
          >
            {imp.cancelRequested ? 'Stopping…' : 'Cancel import'}
          </Button>
        </FormActions>
      ) : null}
    </Section>
  );
}

/**
 * Import mail from another IMAP server (PST-REQ-152): folders land in folders of the same name,
 * Sent/Drafts/Trash/Junk/Archive in ours, with their flags and dates. An interrupted import resumes
 * where it stopped and never files a message twice. The source password is kept encrypted only
 * until the import ends.
 *
 * PST-T-17.11: one form card on the 164/360 grid (.pr-setform), Start import at its foot; the
 * step-up is asked in "Confirm it is you" when the import starts, not as a field of the form; the
 * last import is a card under the form, only when there is one.
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
  const phone = useMediaQuery(PHONE_QUERY);
  const { withStepUp, prompt } = useStepUp('Starting an import hands Postroom the password to another mailbox');

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

  const active = isActive(current);
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

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    setNotice(null);
    const problem = importFormProblem({ host, port, username, password });
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    setBusy(true);
    // A 403 step_up_required opens "Confirm it is you"; once the code is accepted the start runs
    // again. Cancelling the modal settles with null and leaves the form as it was.
    withStepUp(() => importApi.start(input()))
      .then((started) => {
        if (started === null) return;
        setCurrent(started);
        setPassword('');
        setNotice('Import started. You can leave this page; it carries on.');
      })
      .catch((caught: unknown) => {
        setFormError(importError(caught));
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
        setNotice(next.status === 'cancelled' ? 'Import canceled.' : 'Stopping after the current message. What is already imported stays.');
      })
      .catch((caught: unknown) => {
        setNotice(importError(caught));
      });
  };

  const form = (
    <Section title="Start an import" description="Postroom connects over TLS and keeps the password encrypted only until the import ends.">
      <form onSubmit={submit} noValidate className="pr-setform">
        {formError === null ? null : (
          <Alert tone="danger" dynamic>
            {formError}
          </Alert>
        )}
        <FormField label="Provider" width="lg">
          <Select appearance="filled"
            name="provider"
            options={IMPORT_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            value={presetForHost(host).id}
            onValueChange={choosePreset}
          />
        </FormField>
        <FormField label="Email address or username" width="lg" help="A Gmail, iCloud, Outlook or Fastmail address picks the provider.">
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
        <FormField label="Password" width="lg" help={preset.passwordHint ?? 'An app password if the provider asks for one.'}>
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
        <div className="pr-setform__pair">
          <FormField label="Server" width="lg">
            <Input appearance="filled"
              name="host"
              autoComplete="off"
              spellCheck={false}
              placeholder="imap.example.org"
              required
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
              }}
            />
          </FormField>
          <FormField label="Port" width="xs">
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
        </div>
        <SettingsRow
          className="pr-setform__disclosure"
          title="Advanced"
          description="A self-signed certificate, or only some folders."
          control={(ids) => (
            <IconButton
              className="pr-setform__chevron"
              variant="ghost"
              size="sm"
              label="Advanced"
              icon={<ChevronIcon />}
              aria-expanded={advancedOpen}
              aria-controls={ADVANCED_ID}
              aria-describedby={ids.describedBy}
              onClick={() => {
                setAdvancedOpen((open) => !open);
              }}
            />
          )}
        />
        {advancedOpen ? (
          <div className="pr-setform__group" id={ADVANCED_ID}>
            <FormField label="Trust this certificate" optional width="lg" help="Your own server’s SHA-256 fingerprint, when its certificate is self-signed.">
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
            <FormField label="Only these folders" optional width="lg" help="One per line. Empty imports every folder.">
              <Textarea appearance="filled"
                name="folders"
                rows={3}
                value={folders}
                onChange={(e) => {
                  setFolders(e.target.value);
                }}
              />
            </FormField>
          </div>
        ) : null}
        <FormActions className="pr-setform__actions">
          <Button type="submit" variant="primary" loading={busy}>
            Start import
          </Button>
        </FormActions>
      </form>
    </Section>
  );

  return (
    // PST-T-15.6 / PST-T-17.11: the settings column — 680px, centred, a column of Section cards.
    <Page width="narrow" align="center">
      <PageHeader title="Import" description="Copy folders from another IMAP server into this account. Nothing is deleted there." />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      {loadError !== null ? (
        <>
          <LoadFailed error={loadError} what="your import" onRetry={() => void load()} />
          {form}
        </>
      ) : current === undefined ? (
        <Loading label="Loading your import" />
      ) : current === null ? (
        // Nothing imported yet: the form is the page (critique-settings 2.8 #1, X7).
        form
      ) : active ? (
        <ImportCard imp={current} phone={phone} onCancel={cancel} />
      ) : (
        <>
          {form}
          <ImportCard imp={current} phone={phone} onCancel={cancel} />
        </>
      )}
      {prompt}
    </Page>
  );
}
