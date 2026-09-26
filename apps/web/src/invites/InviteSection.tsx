// Fetches a message's invite (if it has one) and renders InviteCard in the reading pane
// (PST-T-8.4, PST-REQ-134). A message with no text/calendar part answers 404, and nothing is shown.
import { useEffect, useState } from 'react';
import { api, ApiError, type InviteView } from '../api';
import { InviteCard } from './InviteCard';

type State = { status: 'loading' | 'none' | 'error' } | { status: 'ready'; invite: InviteView };

export function InviteSection({ messageId }: { messageId: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    api.invite(messageId).then(
      (invite) => {
        if (live) setState({ status: 'ready', invite });
      },
      (err: unknown) => {
        if (!live) return;
        setState({ status: err instanceof ApiError && err.status === 404 ? 'none' : 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [messageId]);

  if (state.status !== 'ready') return null;
  return <InviteCard messageId={messageId} invite={state.invite} onChanged={(invite) => { setState({ status: 'ready', invite }); }} />;
}
