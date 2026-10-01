import '../settings/settings.css';
import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, DataList, DataListRow, EmptyState, FormActions, FormField, Input, Page, PageHeader, Section, Stack } from '@d3cloud/ui';
import { api, describeError, type Alias } from '../api';
import { Loading, LoadFailed } from './states';

const when = (iso: string | null): string =>
  iso === null ? 'Never' : new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Masked aliases (PST-T-5.7, PST-REQ-112): a random address handed to one site, so a leak names
 * exactly who leaked it. Turn it off and mail to it is refused from then on — no warning to
 * the sender, and nothing already delivered is touched.
 */
export function Aliases() {
  const [rows, setRows] = useState<Alias[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  // PST-T-16.23: the header's New button unmounts while the form is open; folding the form away
  // (Cancel, or done) hands focus back to it, as Account's Change password does.
  const newButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!creating && returnFocus.current) {
      returnFocus.current = false;
      newButton.current?.focus();
    }
  }, [creating]);
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

  // PST-T-16.23: the form is not in the DOM until "New alias" is pressed, and closes once it has made one.
  const closeForm = () => {
    returnFocus.current = true;
    setCreating(false);
    setSite('');
    setFormError(null);
  };

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

  const turnOff = (row: Alias) => {
    setNotice(null);
    api
      .killAlias(row.id)
      .then(async () => {
        setNotice(`Turned off ${row.address}. Mail to it is refused from now on.`);
        await load();
      })
      .catch((caught: unknown) => {
        setNotice(describeError(caught));
      });
  };

  const turnOn = (row: Alias) => {
    setNotice(null);
    api
      .reviveAlias(row.id)
      .then(async () => {
        setNotice(`Turned on ${row.address}.`);
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

  return (
    // PST-T-15.6: the settings grid — a 680px column of Section cards; each alias is a row.
    <Page width="narrow">
      <PageHeader
        title="Masked aliases"
        description="Give every site its own random address. If it leaks, turn off the alias — mail to it is refused, no warning sent."
        {...(rows === null ? {} : { count: rows.length, countNoun: { one: 'alias', other: 'aliases' } })}
        actions={
          creating ? null : (
            <Button
              ref={newButton}
              variant="primary"
              onClick={() => {
                setNotice(null);
                setCreating(true);
              }}
            >
              New alias
            </Button>
          )
        }
      />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      {!creating ? null : (
        <Section title="New alias">
          <form onSubmit={create}>
            <Stack gap="16">
              <FormField label="Site" width="lg" help="What you're handing this address to, e.g. shop.example." {...(formError === null ? {} : { error: formError })}>
                <Input appearance="filled"
                  autoFocus
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
                <Button type="button" onClick={closeForm}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" loading={busy}>
                  Create alias
                </Button>
              </FormActions>
            </Stack>
          </form>
        </Section>
      )}

      {loadError !== null ? (
        <LoadFailed error={loadError} what="aliases" onRetry={() => void load()} />
      ) : rows === null ? (
        <Loading label="Loading aliases" />
      ) : (
        <Section title="Your masked aliases" description="Turning one off refuses mail to it from then on. Mail already delivered stays.">
          <DataList aria-label="Your masked aliases" empty={<EmptyState kind="empty" heading="No masked aliases yet" headingLevel={3} size="inline" />}>
            {rows.map((a) => (
              <DataListRow
                key={a.id}
                title={<span className="pr-set-mono">{a.address}</span>}
                description={`For ${a.site} · ${String(a.receivedCount)} received · ${a.lastUsedAt === null ? 'never used' : `last used ${when(a.lastUsedAt)}`}`}
                meta={a.killedAt === null ? <Badge tone="neutral">Live</Badge> : <Badge tone="danger">Off</Badge>}
                actions={
                  <>
                    <Button variant="ghost" size="sm" aria-label={`${copiedId === a.id ? 'Copied' : 'Copy'} ${a.address}`} onClick={() => { copy(a); }}>
                      {copiedId === a.id ? 'Copied' : 'Copy'}
                    </Button>
                    {a.killedAt === null ? (
                      <Button variant="danger-ghost" size="sm" aria-label={`Turn off ${a.address}`} onClick={() => { turnOff(a); }}>
                        Turn off
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" aria-label={`Turn on ${a.address}`} onClick={() => { turnOn(a); }}>
                        Turn on
                      </Button>
                    )}
                  </>
                }
              />
            ))}
          </DataList>
        </Section>
      )}
    </Page>
  );
}
