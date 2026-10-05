import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Cluster,
  DataList,
  DataListRow,
  EmptyState,
  FormField,
  Input,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  Stack,
  StatusDot,
  type StatusDotTone,
} from '@d3cloud/ui';
import { useStepUp } from '../admin/sign-in/step-up';
import { api, describeError, type CreatedInvite, type InviteRow, type People, type PersonRow } from '../api';
import { RelativeTime } from '../components/RelativeTime';
import { CopyButton } from './AdminDns';
import { Loading, LoadFailed } from './states';
import '../admin/admin.css';
import '../admin/lists.css';

/** An account's standing, in words, and the dot's tone (PST-T-20.3, PST-ADR-016). */
export function personStatus(p: Pick<PersonRow, 'disabledAt' | 'deleteAfter' | 'secondFactor'>): { tone: StatusDotTone; words: string } {
  if (p.deleteAfter !== null) return { tone: 'warning', words: 'Deleting' };
  if (p.disabledAt !== null) return { tone: 'idle', words: 'Disabled' };
  if (p.secondFactor === 'none') return { tone: 'attention', words: 'Setting up' };
  return { tone: 'neutral', words: 'Active' };
}

const INVITE_WORDS: Record<InviteRow['state'], string> = { pending: 'Waiting', accepted: 'Accepted', revoked: 'Withdrawn', expired: 'Expired' };

/** An invite's state, in words, and the dot's tone. */
export function inviteStatus(i: Pick<InviteRow, 'state'>): { tone: StatusDotTone; words: string } {
  return { tone: i.state === 'pending' ? 'attention' : 'idle', words: INVITE_WORDS[i.state] };
}

/** "3 accounts", "1 invite": a list's toolbar count. */
export const countOf = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Admin › People (PST-T-20.2, PST-T-20.3): who has an account here, the invites that make new ones,
 * and accounts waiting out their deletion grace period — which an admin can restore until the purge
 * runs. An invite link is shown once (the server keeps only its hash); the person opens it on the web
 * or pastes it into D3 Constellation. Every write asks for a fresh code first.
 */
export function AdminPeople() {
  const [people, setPeople] = useState<People | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<CreatedInvite | null>(null);
  const { withStepUp, prompt } = useStepUp('Inviting someone, withdrawing an invite or restoring an account changes who can sign in');

  const load = useCallback(async () => {
    try {
      setPeople(await api.people());
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openInvite = () => {
    setAddress('');
    setDisplayName('');
    setIsAdmin(false);
    setFormError(null);
    setMade(null);
    setInviting(true);
  };

  const submitInvite = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    const input = { address: address.trim(), ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }), isAdmin };
    withStepUp(() => api.createInvite(input))
      .then(async (result) => {
        if (result === null) return;
        setMade(result);
        await load();
      })
      .catch((caught: unknown) => {
        setFormError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const act = (action: () => Promise<unknown>, done: string) => {
    setNotice(null);
    withStepUp(action)
      .then(async (result) => {
        if (result === null) return;
        setNotice(done);
        await load();
      })
      .catch((caught: unknown) => {
        setNotice(describeError(caught));
      });
  };

  const domain = people?.domain ?? '';

  return (
    <Page>
      <PageHeader
        title="People"
        description="Everyone with an account here, and the invites that make new ones. A deleted account waits seven days before its mail is destroyed; until then you can restore it."
        actions={
          <Button variant="primary" onClick={openInvite}>
            Invite someone
          </Button>
        }
      />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      {loadError !== null ? (
        <LoadFailed error={loadError} what="people" onRetry={() => void load()} />
      ) : people === null ? (
        <Loading label="Loading people" />
      ) : (
        <Stack gap="24">
          <Card className="pr-table-card" as="section" aria-label="Accounts">
            <div className="pr-table-toolbar">
              <span className="pr-list-count">{countOf(people.accounts.length, 'account')}</span>
            </div>
            <DataList aria-label="Accounts" empty={<EmptyState kind="empty" heading="No accounts" headingLevel={2} size="inline" />}>
              {people.accounts.map((p) => {
                const status = personStatus(p);
                return (
                  <DataListRow
                    key={p.id}
                    truncate={false}
                    title={p.displayName}
                    meta={<StatusDot tone={status.tone}>{status.words}</StatusDot>}
                    description={
                      <span className="pr-list-desc">
                        {p.address === null ? 'No address' : <span className="pr-mono">{p.address}</span>} · {p.isAdmin ? 'Admin' : 'Member'}
                        {p.deleteAfter === null ? null : (
                          <>
                            {' · deleted for good '}
                            <RelativeTime iso={p.deleteAfter} />
                          </>
                        )}
                      </span>
                    }
                    actions={
                      p.deleteAfter === null ? null : (
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`Restore ${p.displayName}'s account`}
                          onClick={() => {
                            act(() => api.restoreAccount(p.id), `Restored ${p.displayName}'s account. They sign in again with their password and authenticator.`);
                          }}
                        >
                          Restore
                        </Button>
                      )
                    }
                  />
                );
              })}
            </DataList>
          </Card>

          <Card className="pr-table-card" as="section" aria-label="Invites">
            <div className="pr-table-toolbar">
              <span className="pr-list-count">{countOf(people.invites.length, 'invite')}</span>
            </div>
            <DataList
              aria-label="Invites"
              empty={
                <EmptyState kind="empty" heading="No invites yet" headingLevel={2} size="inline">
                  Invite someone to give them an address at {domain}.
                </EmptyState>
              }
            >
              {people.invites.map((i) => {
                const status = inviteStatus(i);
                return (
                  <DataListRow
                    key={i.id}
                    truncate={false}
                    title={<span className="pr-mono">{i.address}</span>}
                    meta={<StatusDot tone={status.tone}>{status.words}</StatusDot>}
                    description={
                      <span className="pr-list-desc">
                        {i.isAdmin ? 'Admin' : 'Member'}
                        {i.createdBy === null ? null : ` · invited by ${i.createdBy}`} · {i.state === 'pending' ? 'expires ' : 'sent '}
                        <RelativeTime iso={i.state === 'pending' ? i.expiresAt : i.createdAt} />
                      </span>
                    }
                    actions={
                      i.state === 'pending' ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`Withdraw the invite to ${i.address}`}
                          onClick={() => {
                            act(() => api.revokeInvite(i.id), `Withdrew the invite to ${i.address}.`);
                          }}
                        >
                          Withdraw
                        </Button>
                      ) : null
                    }
                  />
                );
              })}
            </DataList>
          </Card>
        </Stack>
      )}

      <Modal
        open={inviting}
        onOpenChange={setInviting}
        title={made === null ? 'Invite someone' : 'Send them this link'}
        description={
          made === null
            ? 'They choose their name, password and authenticator. The link works once, for seven days.'
            : 'It is shown only now. They can open it in a browser or paste it into D3 Constellation.'
        }
        footer={
          made === null ? (
            <>
              <ModalClose>
                <Button type="button">Cancel</Button>
              </ModalClose>
              <Button type="submit" form="invite-form" variant="primary" loading={busy}>
                Create invite
              </Button>
            </>
          ) : (
            <ModalClose>
              <Button type="button" variant="primary">
                Done
              </Button>
            </ModalClose>
          )
        }
      >
        {made === null ? (
          <form id="invite-form" onSubmit={submitInvite}>
            <Stack gap="12">
              {formError === null ? null : (
                <Alert tone="danger" dynamic>
                  {formError}
                </Alert>
              )}
              <FormField label="Address" help={`Just the name: it becomes name@${domain}.`}>
                <Input
                  appearance="filled"
                  name="address"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  required
                  value={address}
                  onChange={(e) => {
                    setAddress(e.target.value.toLowerCase());
                  }}
                />
              </FormField>
              <FormField label="Display name" help="Optional. They can choose their own.">
                <Input
                  appearance="filled"
                  name="displayName"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                  }}
                />
              </FormField>
              <Checkbox
                label="Make them an admin"
                checked={isAdmin}
                onCheckedChange={(c) => {
                  setIsAdmin(c === true);
                }}
              />
            </Stack>
          </form>
        ) : (
          <Stack gap="12">
            <p>
              An invite for <span className="pr-mono">{made.address}</span>. It works once and expires <RelativeTime iso={made.expiresAt} />.
            </p>
            <Cluster gap="8" align="center">
              <code className="pr-mono pr-clip" data-testid="invite-url">
                {made.url}
              </code>
              <CopyButton value={made.url} label="invite link" />
            </Cluster>
          </Stack>
        )}
      </Modal>
      {prompt}
    </Page>
  );
}
