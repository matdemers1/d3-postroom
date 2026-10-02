import '../settings/settings.css';
import './inline-forms.css';
import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  DataList,
  DataListRow,
  EmptyState,
  FormActions,
  FormField,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Page,
  PageHeader,
  Section,
  StatusDot,
} from '@d3cloud/ui';
import { api, describeError, type Alias } from '../api';
import { RelativeTime } from '../components/RelativeTime';
import { MoreIcon } from '../mail/thread/icons';
import { aliasActions, aliasFacts, aliasStatus, type AliasAction } from './aliases-format';
import { Loading, LoadFailed } from './states';

/**
 * Addresses: masked aliases (PST-T-5.7, PST-REQ-112) — a random address handed to one site, so a
 * leak names exactly who leaked it. Turn it off and mail to it is refused from then on — no warning
 * to the sender, and nothing already delivered is touched.
 *
 * PST-T-17.10: one card. Its head holds New alias; the form opens inside it above the list, on the
 * 164/360 grid; each row's status is a dot and a word, and its two actions sit behind one ⋯ menu.
 */
export function Aliases() {
  const [rows, setRows] = useState<Alias[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
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
  const [site, setSite] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        setNotice(`Turned off ${row.address}. Mail to it is refused from now on; mail already delivered stays.`);
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
    setNotice(null);
    navigator.clipboard
      .writeText(row.address)
      .then(() => {
        setNotice(`Copied ${row.address}.`);
      })
      .catch(() => {
        setNotice(`Could not copy ${row.address}. Select it and copy it instead.`);
      });
  };

  const run = (action: AliasAction, row: Alias) => {
    if (action === 'copy') copy(row);
    else if (action === 'turn-off') turnOff(row);
    else turnOn(row);
  };

  return (
    // PST-T-15.6: the settings grid — a 680px column, centred (PST-T-17.10); each alias is a row.
    <Page width="narrow" align="center">
      <PageHeader
        title="Addresses"
        description="A random address for every site. Turn one off and its mail is refused."
        {...(rows === null || rows.length === 0 ? {} : { count: rows.length, countNoun: { one: 'alias', other: 'aliases' } })}
      />

      <Section
        title="Masked aliases"
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
              New alias
            </Button>
          )
        }
      >
        {notice === null ? null : (
          <Alert tone="info" dynamic>
            {notice}
          </Alert>
        )}

        {!creating ? null : (
          <form className="pr-setform pr-inline-form" aria-labelledby="alias-new" onSubmit={create}>
            <div className="pr-inline-form__head">
              <h3 id="alias-new" className="pr-inline-form__title">
                New alias
              </h3>
            </div>
            <FormField label="Site" width="lg" help="What you’re handing it to, e.g. shop.example." {...(formError === null ? {} : { error: formError })}>
              <Input
                appearance="filled"
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
            <FormActions className="pr-setform__actions">
              <Button type="button" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                Create alias
              </Button>
            </FormActions>
          </form>
        )}

        {loadError !== null ? (
          <LoadFailed error={loadError} what="aliases" onRetry={() => void load()} headingLevel={3} size="row" />
        ) : rows === null ? (
          <Loading label="Loading aliases" height={96} />
        ) : creating && rows.length === 0 ? null : (
          <DataList
            aria-label="Your masked aliases"
            empty={
              <EmptyState kind="empty" heading="No masked aliases yet" headingLevel={3} size="row">
                Make one for the next site that asks for your email.
              </EmptyState>
            }
          >
            {rows.map((a) => {
              const status = aliasStatus(a);
              return (
                <DataListRow
                  key={a.id}
                  truncate={false}
                  title={<span className={`pr-set-mono${a.killedAt === null ? '' : ' pr-alias-off'}`}>{a.address}</span>}
                  description={
                    <>
                      {aliasFacts(a)} ·{' '}
                      {a.lastUsedAt === null ? (
                        'never used'
                      ) : (
                        <>
                          last used <RelativeTime iso={a.lastUsedAt} />
                        </>
                      )}
                    </>
                  }
                  meta={
                    <StatusDot size="sm" tone={status.tone}>
                      {status.label}
                    </StatusDot>
                  }
                  actions={
                    <Menu>
                      <MenuTrigger>
                        <IconButton size="sm" variant="ghost" label={`Actions for ${a.address}`} icon={<MoreIcon />} />
                      </MenuTrigger>
                      <MenuContent align="end">
                        {aliasActions(a).map((item) => (
                          <MenuItem
                            key={item.action}
                            onSelect={() => {
                              run(item.action, a);
                            }}
                          >
                            {item.label}
                          </MenuItem>
                        ))}
                      </MenuContent>
                    </Menu>
                  }
                />
              );
            })}
          </DataList>
        )}
      </Section>
    </Page>
  );
}
