// The webmail side of PST-T-9.1: the "Sending… Undo" toast (undo send, PST-REQ-140), the list of
// scheduled sends shown above Drafts (PST-REQ-141) with Cancel and Edit, and the Snooze control in the
// reading pane (PST-REQ-142). The composer closes the moment a held send is accepted, so the toast
// lives outside it: the composer announces the held send here and MailView renders the toast.
//
// The server does the holding: a held message is already in Drafts and the worker queues it at
// releaseAt, so closing the tab during the countdown still sends it — and Undo, or discarding the
// draft from any client, still takes it back until then.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Cluster, Menu, MenuContent, MenuItem, MenuTrigger } from '@d3cloud/ui';
import { api, ApiError, type Mailbox, type PendingSend } from '../api';
import { snoozeChoices, toastState } from './compose';
import { useMail } from './MailContext';
import { mailPath } from './route';

// --- The held-send announcement (composer → toast) ------------------------------------------------

type Listener = () => void;
let current: PendingSend | null = null;
const listeners = new Set<Listener>();

/** The composer calls this with the held send the server answered (202). */
export function announceHeld(pending: PendingSend | null): void {
  current = pending;
  for (const l of listeners) l();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** "Sending… Undo", counting down; or "Scheduled for …" with Undo. Rendered once, by MailView. */
export function UndoSendToast() {
  const pending = useSyncExternalStore(subscribe, () => current);
  const { refreshMailboxes, mailboxes } = useMail();
  const navigate = useNavigate();
  const [now, setNow] = useState(() => new Date());
  const [note, setNote] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    if (pending === null) return;
    setNote(null);
    setNow(new Date());
    const timer = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [pending]);

  const state = pending === null ? null : toastState(pending, now);
  // "Sent." stays a moment, then the toast goes; a scheduled one goes after a few seconds.
  useEffect(() => {
    if (pending === null || state === null) return;
    const linger = pending.kind === 'scheduled' ? 8000 : state.done ? 3000 : null;
    if (linger === null) return;
    const t = setTimeout(() => {
      announceHeld(null);
      void refreshMailboxes();
    }, linger);
    return () => {
      clearTimeout(t);
    };
  }, [pending, state?.done, refreshMailboxes]);

  const undo = async () => {
    if (pending === null) return;
    try {
      const undone = await api.undoSend(pending.id);
      announceHeld(null);
      void refreshMailboxes();
      const drafts = mailboxes?.find((m) => m.specialUse === 'drafts');
      setNote({ tone: 'info', text: 'Not sent. It is back in Drafts.' });
      if (drafts !== undefined && undone.draftId !== null) void navigate(mailPath(drafts.id, undone.draftId, 'new'));
    } catch (e) {
      announceHeld(null);
      setNote({ tone: 'danger', text: e instanceof ApiError && e.code === 'not_held' ? 'Too late to undo: it has been sent.' : 'Postroom did not answer, so it could not be undone.' });
    }
  };

  if (pending === null || state === null) {
    return note === null ? null : (
      <div className="pr-undo" role="status" aria-live="polite">
        <Alert tone={note.tone} dynamic actions={<Button size="sm" variant="ghost" onClick={() => { setNote(null); }}>Dismiss</Button>}>
          {note.text}
        </Alert>
      </div>
    );
  }
  return (
    <div className="pr-undo" role="status" aria-live="polite" data-pending-id={pending.id}>
      <Alert tone="info" dynamic actions={state.canUndo ? <Button size="sm" variant="secondary" onClick={() => void undo()}>Undo</Button> : undefined}>
        {state.text}
      </Alert>
    </div>
  );
}

// --- Scheduled sends, above the Drafts list --------------------------------------------------------

/** Held sends, soonest first, with Cancel and Edit (cancel, then open the draft in the composer). */
export function ScheduledSends({ drafts }: { drafts: Mailbox }) {
  const { subscribe: subscribeEvents, refreshMailboxes } = useMail();
  const navigate = useNavigate();
  const [pending, setPending] = useState<PendingSend[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .pendingSends()
      .then((r) => {
        setPending(r.pending.filter((p) => p.kind === 'scheduled'));
      })
      .catch(() => {
        setPending([]);
      });
  }, []);

  useEffect(() => {
    load();
    return subscribeEvents(() => {
      load();
    });
  }, [load, subscribeEvents]);

  const cancel = async (p: PendingSend, edit: boolean) => {
    setError(null);
    try {
      const undone = await api.undoSend(p.id);
      load();
      void refreshMailboxes();
      if (edit && undone.draftId !== null) void navigate(mailPath(drafts.id, undone.draftId, 'new'));
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'not_held' ? 'That one has already been sent.' : 'Postroom did not answer. Try again.');
      load();
    }
  };

  if (pending === null || pending.length === 0) return null;
  return (
    <section className="pr-scheduled" aria-labelledby="pr-scheduled-title">
      <h3 id="pr-scheduled-title" className="pr-scheduled__title">
        Scheduled
      </h3>
      {error !== null ? (
        <Alert tone="danger" dynamic>
          {error}
        </Alert>
      ) : null}
      <ul className="pr-scheduled__list">
        {pending.map((p) => (
          <li key={p.id} className="pr-scheduled__item" data-pending-id={p.id}>
            <span className="pr-scheduled__what">
              {p.subject === '' ? '(no subject)' : p.subject} <span className="pr-scheduled__to">to {p.to}</span>
            </span>
            <span className="pr-scheduled__when">{new Date(p.releaseAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <Cluster gap="8">
              <Button size="sm" variant="ghost" onClick={() => void cancel(p, true)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void cancel(p, false)}>
                Cancel
              </Button>
            </Cluster>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- Snooze, in the reading pane -------------------------------------------------------------------

/** Snooze the open conversation (from INBOX), or bring a snoozed one back. */
export function SnoozeControl({ threadId, snoozed, inInbox, onDone }: { threadId: string | null; snoozed: boolean; inInbox: boolean; onDone: (text: string) => void }) {
  const { refreshMailboxes } = useMail();
  const [busy, setBusy] = useState(false);
  if (threadId === null || (!snoozed && !inInbox)) return null;

  const run = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await f();
      void refreshMailboxes();
      onDone(done);
    } catch {
      onDone('Postroom did not answer, so nothing changed.');
    } finally {
      setBusy(false);
    }
  };

  if (snoozed) {
    return (
      <Button size="sm" variant="ghost" loading={busy} onClick={() => void run(() => api.unsnoozeThread(threadId), 'Back in Inbox.')}>
        Unsnooze
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger>
        <Button size="sm" variant="ghost" loading={busy}>
          Snooze
        </Button>
      </MenuTrigger>
      <MenuContent aria-label="Snooze until">
        {snoozeChoices(new Date()).map((c) => (
          <MenuItem
            key={c.label}
            onSelect={() => {
              void run(() => api.snoozeThread(threadId, c.until.toISOString()), `Snoozed until ${c.until.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`);
            }}
          >
            {c.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
