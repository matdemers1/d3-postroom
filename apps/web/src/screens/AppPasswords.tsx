import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Cluster,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
  Table,
  Textarea,
  type TableColumn,
} from '@d3cloud/ui';
import { api, describeError, type AppPassword, type AppPasswordScope } from '../api';
import { relativeTime } from './app-passwords-format';

const SCOPES: { scope: AppPasswordScope; label: string }[] = [
  { scope: 'imap', label: 'Read mail (IMAP)' },
  { scope: 'smtp', label: 'Send mail (SMTP)' },
  { scope: 'dav', label: 'Calendars and contacts (DAV)' },
  { scope: 'sieve', label: 'Filters (ManageSieve)' },
];

const when = (iso: string | null): string =>
  iso === null ? 'Never' : new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * App passwords (PST-REQ-027): mail clients sign in with one of these, never the account password.
 * Each is scoped, shown exactly once when created, and revoking it locks its client out at the next
 * connection.
 */
export function AppPasswords() {
  const [rows, setRows] = useState<AppPassword[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<AppPasswordScope[]>(['imap', 'smtp']);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<{ label: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows((await api.appPasswords()).appPasswords);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (scope: AppPasswordScope, on: boolean) => {
    setScopes((current) => (on ? [...current.filter((s) => s !== scope), scope] : current.filter((s) => s !== scope)));
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
        setRevealed({ label: created.label, password: created.password });
        setCopied(false);
        setLabel('');
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
    api
      .revokeAppPassword(row.id)
      .then(async () => {
        setNotice(`Revoked "${row.label}". Its client is signed out at its next connection.`);
        await load();
      })
      .catch((caught: unknown) => {
        setNotice(describeError(caught));
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

  const columns: TableColumn<AppPassword>[] = [
    { key: 'label', header: 'Name', cell: (p) => p.label },
    {
      key: 'scopes',
      header: 'May',
      cell: (p) => (
        <Cluster gap="4">
          {p.scopes.map((s) => (
            <Badge key={s} size="sm">
              {s.toUpperCase()}
            </Badge>
          ))}
        </Cluster>
      ),
    },
    { key: 'createdAt', header: 'Created', cell: (p) => when(p.createdAt) },
    {
      key: 'lastUsedAt',
      header: 'Last used',
      cell: (p) => (p.lastUsedAt === null ? 'Never' : `${relativeTime(p.lastUsedAt)}${p.lastUsedIp === null ? '' : ` from ${p.lastUsedIp}`}`),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (p) => (
        <Button
          variant="danger-ghost"
          size="sm"
          aria-label={`Revoke ${p.label}`}
          onClick={() => {
            revoke(p);
          }}
        >
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="App passwords"
        description="Mail, calendar and contacts apps sign in with an app password, never your account password."
        {...(rows === null ? {} : { count: rows.length, countNoun: { one: 'password', other: 'passwords' } })}
      />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      {revealed === null ? null : (
        <Section title={`Password for ${revealed.label}`} description="Copy it into the app now. You won't see this again.">
          <Stack gap="12">
            <Alert tone="warning" title="Shown once">
              Postroom keeps only a hash. If you lose it, revoke it and create another.
            </Alert>
            <FormField label="App password">
              <Textarea mono readOnly rows={1} value={revealed.password} onFocus={(e) => { e.currentTarget.select(); }} />
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
          </Stack>
        </Section>
      )}

      <Section title="Create an app password">
        <form onSubmit={create}>
          <Stack gap="16">
            <FormField label="Name" help="The device or app it is for, e.g. iPhone Mail." {...(formError === null ? {} : { error: formError })}>
              <Input
                name="label"
                maxLength={100}
                required
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                }}
              />
            </FormField>
            <FormField label="It may" as="group">
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
              <Button type="submit" variant="primary" loading={busy}>
                Create password
              </Button>
            </FormActions>
          </Stack>
        </form>
      </Section>

      {loadError ? (
        <EmptyState kind="error" heading="Could not load app passwords" headingLevel={2} action={<Button onClick={() => void load()}>Try again</Button>}>
          The server did not answer.
        </EmptyState>
      ) : rows === null ? (
        <Skeleton variant="block" />
      ) : (
        <Table
          caption="Your app passwords"
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          empty={<EmptyState kind="empty" heading="No app passwords yet" size="row" />}
        />
      )}
    </Page>
  );
}
