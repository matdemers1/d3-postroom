import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, EmptyState, FormActions, FormField, Input, Page, PageHeader, Section, Stack, Table, type TableColumn } from '@d3cloud/ui';
import { api, describeError, type Alias } from '../api';
import { Loading, LoadFailed } from './states';

const when = (iso: string | null): string =>
  iso === null ? 'Never' : new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Masked aliases (PST-T-5.7, PST-REQ-112): a random address handed to one site, so a leak names
 * exactly who leaked it. Kill it and mail to it is refused with 550 from then on — no warning to
 * the sender, and nothing already delivered is touched.
 */
export function Aliases() {
  const [rows, setRows] = useState<Alias[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [site, setSite] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.aliases()).aliases);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    setNotice(null);
    if (site.trim() === '') {
      setFormError('Say which site this alias is for.');
      return;
    }
    setBusy(true);
    api
      .createAlias({ site: site.trim() })
      .then(async (created) => {
        setNotice(`Created ${created.alias.address} for ${created.alias.site}.`);
        setSite('');
        await load();
      })
      .catch((caught: unknown) => {
        setFormError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const kill = (row: Alias) => {
    setNotice(null);
    api
      .killAlias(row.id)
      .then(async () => {
        setNotice(`Killed ${row.address}. Mail to it is refused from now on.`);
        await load();
      })
      .catch((caught: unknown) => {
        setNotice(describeError(caught));
      });
  };

  const revive = (row: Alias) => {
    setNotice(null);
    api
      .reviveAlias(row.id)
      .then(async () => {
        setNotice(`Revived ${row.address}.`);
        await load();
      })
      .catch((caught: unknown) => {
        setNotice(describeError(caught));
      });
  };

  const copy = (row: Alias) => {
    navigator.clipboard
      .writeText(row.address)
      .then(() => {
        setCopiedId(row.id);
      })
      .catch(() => {
        setCopiedId(null);
      });
  };

  const columns: TableColumn<Alias>[] = [
    {
      key: 'address',
      header: 'Address',
      cell: (a) => (
        <Button variant="ghost" size="sm" aria-label={`Copy ${a.address}`} onClick={() => { copy(a); }}>
          {copiedId === a.id ? 'Copied' : a.address}
        </Button>
      ),
    },
    { key: 'site', header: 'Site', cell: (a) => a.site },
    {
      key: 'status',
      header: 'Status',
      cell: (a) => (a.killedAt === null ? <Badge tone="neutral">Live</Badge> : <Badge tone="danger">Killed</Badge>),
    },
    { key: 'createdAt', header: 'Created', cell: (a) => when(a.createdAt) },
    { key: 'lastUsedAt', header: 'Last used', cell: (a) => when(a.lastUsedAt) },
    { key: 'receivedCount', header: 'Received', cell: (a) => a.receivedCount },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (a) =>
        a.killedAt === null ? (
          <Button variant="danger-ghost" size="sm" aria-label={`Kill ${a.address}`} onClick={() => { kill(a); }}>
            Kill
          </Button>
        ) : (
          <Button variant="ghost" size="sm" aria-label={`Revive ${a.address}`} onClick={() => { revive(a); }}>
            Revive
          </Button>
        ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Masked aliases"
        description="Give every site its own random address. If it leaks, kill the alias — mail to it is refused with 550, no warning sent."
        {...(rows === null ? {} : { count: rows.length, countNoun: { one: 'alias', other: 'aliases' } })}
      />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      <Section title="Create an alias">
        <form onSubmit={create}>
          <Stack gap="16">
            <FormField label="Site" help="What you're handing this address to, e.g. shop.example." {...(formError === null ? {} : { error: formError })}>
              <Input
                name="site"
                maxLength={200}
                required
                value={site}
                onChange={(e) => {
                  setSite(e.target.value);
                }}
              />
            </FormField>
            <FormActions>
              <Button type="submit" variant="primary" loading={busy}>
                Create alias
              </Button>
            </FormActions>
          </Stack>
        </form>
      </Section>

      {loadError !== null ? (
        <LoadFailed error={loadError} what="aliases" onRetry={() => void load()} />
      ) : rows === null ? (
        <Loading label="Loading aliases" />
      ) : (
        <Table
          caption="Your masked aliases"
          columns={columns}
          rows={rows}
          rowKey={(a) => a.id}
          empty={<EmptyState kind="empty" heading="No masked aliases yet" size="row" />}
        />
      )}
    </Page>
  );
}
