// The reading pane's invite card (PST-T-8.4, PST-REQ-134): title, when, organizer, attendee count,
// the caller's current response, and Accept/Maybe/Decline (or, for a CANCEL, Remove from calendar).
// Pure formatting lives in ./view.ts, unit tested there without pulling in @d3cloud/ui.
import { useCallback, useState } from 'react';
import { Alert, Button, DescriptionItem, DescriptionList, Stack } from '@d3cloud/ui';
import { api, ApiError, type InviteView, type Partstat } from '../api';
import {
  attendeeCountLabel,
  inviteWhen,
  isCurrentAnswer,
  offersRemoval,
  offersResponse,
  organizerLabel,
  partstatLabel,
  responseAnnouncement,
} from './view';

export interface InviteCardProps {
  messageId: string;
  invite: InviteView;
  /** Called after a successful respond/remove, with the invite as the server now reports it. */
  onChanged: (invite: InviteView) => void;
}

type Busy = Partstat | 'remove' | null;

export function InviteCard({ messageId, invite, onChanged }: InviteCardProps) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.invite(messageId).then(onChanged, () => undefined);
  }, [messageId, onChanged]);

  const respond = useCallback(
    (partstat: Partstat) => {
      setBusy(partstat);
      setError(null);
      api.respondToInvite(messageId, partstat).then(
        () => {
          setBusy(null);
          setAnnouncement(responseAnnouncement(partstat));
          refresh();
        },
        (err: unknown) => {
          setBusy(null);
          setError(err instanceof ApiError ? errorMessage(err) : 'Postroom did not answer. Check your connection.');
        },
      );
    },
    [messageId, refresh],
  );

  const remove = useCallback(() => {
    setBusy('remove');
    setError(null);
    api.removeInviteFromCalendar(messageId).then(
      () => {
        setBusy(null);
        setAnnouncement('Removed from your calendar.');
        refresh();
      },
      (err: unknown) => {
        setBusy(null);
        setError(err instanceof ApiError ? errorMessage(err) : 'Postroom did not answer. Check your connection.');
      },
    );
  }, [messageId, refresh]);

  const when = inviteWhen(invite);

  return (
    <section aria-label="Invitation" className="pr-invite" data-testid="invite-card">
      <Stack gap="12">
        {invite.cancelled ? (
          <Alert tone="warning" title="This event was cancelled">
            The organizer cancelled {invite.summary === '' ? 'this event' : `“${invite.summary}”`}.
          </Alert>
        ) : null}
        <DescriptionList className="pr-invite__meta">
          <DescriptionItem term="Event">{invite.summary === '' ? '(no title)' : invite.summary}</DescriptionItem>
          {when !== '' ? <DescriptionItem term="When">{when}</DescriptionItem> : null}
          <DescriptionItem term="Organizer">{organizerLabel(invite)}</DescriptionItem>
          <DescriptionItem term="Attendees">{attendeeCountLabel(invite)}</DescriptionItem>
          <DescriptionItem term="Your response">{partstatLabel(invite.you?.partstat)}</DescriptionItem>
        </DescriptionList>
        {error !== null ? (
          <Alert tone="warning" title="That did not go through">
            {error}
          </Alert>
        ) : null}
        {offersResponse(invite) ? (
          <div role="group" aria-label="Respond to this invitation" className="pr-invite__actions">
            <Button size="sm" variant="primary" pressed={isCurrentAnswer(invite, 'ACCEPTED')} disabled={busy !== null} onClick={() => { respond('ACCEPTED'); }}>
              Accept
            </Button>{' '}
            <Button size="sm" variant="secondary" pressed={isCurrentAnswer(invite, 'TENTATIVE')} disabled={busy !== null} onClick={() => { respond('TENTATIVE'); }}>
              Maybe
            </Button>{' '}
            <Button size="sm" variant="ghost" pressed={isCurrentAnswer(invite, 'DECLINED')} disabled={busy !== null} onClick={() => { respond('DECLINED'); }}>
              Decline
            </Button>
          </div>
        ) : null}
        {offersRemoval(invite) ? (
          <div className="pr-invite__actions">
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={remove}>
              Remove from calendar
            </Button>
          </div>
        ) : null}
        <div role="status" aria-live="polite" className="pr-invite__announcement">
          {announcement}
        </div>
      </Stack>
    </section>
  );
}

function errorMessage(err: ApiError): string {
  if (typeof err.body === 'object' && err.body !== null && typeof (err.body as { message?: unknown }).message === 'string') {
    return (err.body as { message: string }).message;
  }
  return 'That did not go through.';
}
