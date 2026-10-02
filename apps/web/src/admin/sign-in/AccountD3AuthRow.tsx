// Settings › Account › Sign-in: the "Sign in with D3 Auth" row (PST-T-17.7, PST-REQ-202). Linked:
// the D3 Auth email and Unlink (a confirm, then step-up). Not linked: Link…, a real navigation to
// the server, which asks for a fresh sign-in first when the last one is older than five minutes.
// Hidden while D3 Auth is not available, so it never offers a door that will not open.
// PST-T-17.16 (PST-ADR-015): a link the server would not make comes back here — refused, because the
// identity belongs to another account (shown in an alert), or because the session is older than
// five minutes (the code prompt opens, then the link starts again).
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Modal, ModalClose, SettingsRow, useToast } from '@d3cloud/ui';
import { api, describeError, d3authApi, OIDC_LINK_PATH, type LinkedIdentity } from '../../api';
import { accountLinkNoticeFrom, accountRowDescription, LINK_STEP_UP_WHY, UNLINK_COPY } from './model';
import { useStepUp } from './step-up';

export const ROW_TITLE = 'Sign in with D3 Auth';

export function D3AuthRowView({ identity, onLink, onUnlink }: { identity: LinkedIdentity | null; onLink: () => void; onUnlink: () => void }) {
  return (
    <SettingsRow
      title={ROW_TITLE}
      description={accountRowDescription(identity)}
      data-d3auth-row={identity === null ? 'unlinked' : 'linked'}
      control={
        identity === null ? (
          <Button size="sm" variant="secondary" aria-label="Link D3 Auth" onClick={onLink}>
            Link…
          </Button>
        ) : (
          <Button size="sm" variant="ghost" aria-label="Unlink D3 Auth" onClick={onUnlink}>
            Unlink
          </Button>
        )
      }
    />
  );
}

/** Reads its own state: renders nothing until it knows D3 Auth is available. */
export function AccountD3AuthRow() {
  const [available, setAvailable] = useState(false);
  const [identities, setIdentities] = useState<LinkedIdentity[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const toast = useToast();
  const { withStepUp, prompt } = useStepUp('Unlinking removes a way to sign in to this account');
  const { askFirst: confirmToLink, prompt: linkPrompt } = useStepUp(LINK_STEP_UP_WHY);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Read once, then cleared from the URL so a reload does not repeat it.
  useEffect(() => {
    const notice = accountLinkNoticeFrom(window.location.search);
    if (notice === null) return;
    window.history.replaceState(null, '', window.location.pathname);
    if (notice.kind === 'error') {
      setLinkError(notice.message);
      return;
    }
    // A real navigation once the code is accepted: the server answers with a redirect to D3 Auth.
    void confirmToLink(() => {
      window.location.assign(OIDC_LINK_PATH);
      return Promise.resolve(true);
    });
  }, [confirmToLink]);

  const load = useCallback(async () => {
    try {
      const state = await api.state();
      setAvailable(state.oidcAvailable);
      if (state.oidcAvailable) setIdentities(await d3authApi.identities());
    } catch {
      // The rest of the screen says when the server is not answering; this row just stays away.
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refusal =
    linkError === null ? null : (
      <Alert tone="danger" title="D3 Auth was not linked" dynamic>
        {linkError}
      </Alert>
    );

  if (!available || identities === null) {
    return (
      <>
        {refusal}
        {prompt}
        {linkPrompt}
      </>
    );
  }
  const identity = identities[0] ?? null;

  const unlink = () => {
    setConfirming(false);
    if (identity === null) return;
    // A cancelled step-up settles null; a done unlink answers its result.
    withStepUp(() => d3authApi.unlink(identity.id))
      .then(async (done) => {
        if (done === null) return;
        // This browser signed in through the identity just unlinked: its session ended with it.
        if (done.signedOut) {
          window.location.assign('/signin');
          return;
        }
        toast.show({ message: 'D3 Auth unlinked. Your password keeps working.' });
        await load();
      })
      .catch((caught: unknown) => {
        toast.show({ message: describeError(caught) });
      });
  };

  return (
    <>
      {refusal}
      <D3AuthRowView
        identity={identity}
        onLink={() => {
          window.location.assign(OIDC_LINK_PATH);
        }}
        onUnlink={() => {
          setConfirming(true);
        }}
      />
      <Modal
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        destructive
        title="Unlink D3 Auth"
        description={UNLINK_COPY}
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="button" variant="danger" onClick={unlink}>
              Unlink
            </Button>
          </>
        }
      />
      {prompt}
      {linkPrompt}
    </>
  );
}
