// The composer (PST-T-3.11, PST-REQ-079): a new message, reply, reply-all or forward, prefilled by
// compose.ts; sent through the server's submission path (POST /api/compose/send), which files it in
// Sent and threads it; and kept as a draft in the Drafts mailbox while it is being written —
// autosaved a few seconds after the last keystroke, saved at once with "Save draft", and kept when
// the composer is closed with Escape. "Discard" throws the draft away.
//
// A draft is picked up again when the same composer reopens: a reply, reply-all or forward finds the
// draft it left for the same message; pressing c (compose) with a draft open in Drafts resumes that
// draft.
//
// After sending, the composer closes back to the message it answered (PST-T-3.15): the server has
// already filed and threaded the reply by the time send() resolves, so the open thread there shows
// it without a reload — no separate "sent" screen needed to say so. The mailbox list updates over SSE.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Button, FormActions, FormField, Input, Select, Stack, Textarea } from '@d3cloud/ui';
import { api, ApiError, type DraftInput } from '../api';
import {
  fieldsOf,
  hasRecipients,
  initialState,
  isHeld,
  REMIND_CHOICES,
  resumableDraft,
  sendErrorText,
  sendOptions,
  stateFromSaved,
  toLocalInput,
  undoSeconds,
  type ComposeDraft,
  type ComposeState,
  type SendTiming,
} from './compose';
import { useMail } from './MailContext';
import { parseMailRoute } from './route';
import { announceHeld } from './Scheduled';

/** The browser's storage, or null where there is none (a locked-down profile). */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const TITLES: Readonly<Record<ComposeDraft['mode'], string>> = {
  new: 'New message',
  reply: 'Reply',
  replyall: 'Reply all',
  forward: 'Forward',
};

/** How long after the last change a draft is saved on its own. */
export const AUTOSAVE_MS = 3000;

type SaveStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: string } | { kind: 'failed' };

export function Composer({ draft, onDiscard, back }: { draft: ComposeDraft; onDiscard: () => void; back?: ReactNode }) {
  const { me, refreshMailboxes } = useMail();
  const location = useLocation();
  const [state, setState] = useState<ComposeState>(() => initialState(draft));
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [resumed, setResumed] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PST-T-9.1: send later (PST-REQ-141) and remind if no reply (PST-REQ-143).
  const [timing, setTiming] = useState<SendTiming>({ kind: 'now' });
  const [remind, setRemind] = useState<number | null>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Everything a timer, an unmount or a queued save needs, current.
  const latest = useRef(state);
  latest.current = state;
  const draftId = useRef<string | null>(null);
  /** Bumped on every edit; a save records the version it wrote, so "dirty" is version !== saved. */
  const version = useRef(0);
  const savedVersion = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finished = useRef(false);

  const edit = (patch: Partial<ComposeState>) => {
    version.current += 1;
    setState((s) => ({ ...s, ...patch }));
  };

  const draftInput = useCallback(
    (s: ComposeState): DraftInput => ({ ...fieldsOf(s), ...(me === null ? {} : { from: me }), mode: draft.mode, sourceId: draft.sourceId }),
    [me, draft.mode, draft.sourceId],
  );

  /** Save now (queued behind any save in flight). Resolves when this save has settled. `force` saves
   *  even an untouched prefill (the explicit button); otherwise only unsaved changes are written. */
  const save = useCallback((force = false): Promise<void> => {
    const run = async () => {
      if (finished.current || (!force && version.current === savedVersion.current)) return;
      const at = version.current;
      const input = draftInput(latest.current);
      setSaveStatus({ kind: 'saving' });
      try {
        let saved;
        if (draftId.current === null) saved = await api.createDraft(input);
        else {
          try {
            saved = await api.replaceDraft(draftId.current, input);
          } catch (e) {
            // Gone (sent or discarded in another tab): start a new one.
            if (!(e instanceof ApiError && e.status === 404)) throw e;
            saved = await api.createDraft(input);
          }
        }
        draftId.current = saved.id;
        savedVersion.current = at;
        setSaveStatus({ kind: 'saved', at: saved.savedAt });
      } catch {
        setSaveStatus({ kind: 'failed' });
      }
    };
    const next = chain.current.then(run);
    chain.current = next.catch(() => undefined);
    return next;
  }, [draftInput]);

  const cancelTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  // Autosave: a few seconds after the last change.
  useEffect(() => {
    if (version.current === savedVersion.current || finished.current) return;
    cancelTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      void save();
    }, AUTOSAVE_MS);
    return cancelTimer;
  }, [state, save]);

  // Closing the composer any way but Discard or Send keeps what was typed.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(
    () => () => {
      cancelTimer();
      if (!finished.current && version.current !== savedVersion.current) void saveRef.current();
    },
    [],
  );

  // Pick up a draft this composer left before.
  useEffect(() => {
    let cancelled = false;
    const apply = (saved: Parameters<typeof stateFromSaved>[0]) => {
      if (cancelled || version.current !== 0) return; // never over what the person already typed
      draftId.current = saved.id;
      setState(stateFromSaved(saved));
      setResumed(true);
    };
    const messageId = parseMailRoute(location.pathname, location.search)?.messageId ?? null;
    if (draft.mode === 'new' && messageId !== null) {
      // c with a draft open resumes it (anything else answers 404 and the composer stays blank).
      api
        .draft(messageId)
        .then(apply)
        .catch(() => undefined);
    } else if (draft.sourceId !== null) {
      api
        .drafts(draft.inReplyTo === null ? {} : { inReplyTo: draft.inReplyTo })
        .then(({ drafts }) => {
          const found = resumableDraft(drafts, draft);
          if (found !== null) apply(found);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // Once, for the draft this composer was opened with (MailView keys the composer by it).
  }, []);

  // A reply already knows who it is for: start in the text, at the top, above the quote.
  useEffect(() => {
    if (draft.to === '') toRef.current?.focus();
    else {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(0, 0);
    }
  }, [draft.to]);

  const send = async () => {
    setError(null);
    if (!hasRecipients(latest.current)) {
      setError('Add at least one recipient.');
      toRef.current?.focus();
      return;
    }
    if (me === null) {
      setError('Your account has no address to send from.');
      return;
    }
    const timed = sendOptions(timing, undoSeconds(storage()), remind, new Date());
    if (!timed.ok) {
      setError(timed.error);
      return;
    }
    setSending(true);
    cancelTimer();
    // Let a save in flight land first, so the draft it made is the one the send removes.
    await chain.current;
    try {
      const result = await api.sendOrHold({ ...fieldsOf(latest.current), from: me, draftId: draftId.current, ...timed.options });
      // Held (undo window or scheduled): the toast outside the composer offers Undo (PST-REQ-140).
      if (isHeld(result)) announceHeld(result);
      finished.current = true;
      void refreshMailboxes();
      // The server has already filed and threaded the reply: closing back to the message it
      // answered shows it there, in the open thread, without a reload (PST-T-3.15).
      onDiscard();
      return;
    } catch (e) {
      setError(sendErrorText(e));
    } finally {
      setSending(false);
    }
  };

  const discard = () => {
    finished.current = true;
    cancelTimer();
    const id = draftId.current;
    // Behind any save in flight, so a draft it is creating is the one removed.
    void chain.current.then(async () => {
      const current = draftId.current ?? id;
      if (current !== null) await api.deleteDraft(current).catch(() => undefined);
      void refreshMailboxes();
    });
    onDiscard();
  };

  const status =
    saveStatus.kind === 'saving'
      ? 'Saving draft…'
      : saveStatus.kind === 'saved'
        ? `Draft saved ${new Date(saveStatus.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`
        : saveStatus.kind === 'failed'
          ? 'The draft could not be saved. It will be tried again as you type.'
          : resumed
            ? 'Picked up your saved draft.'
            : '';

  return (
    <section
      className="pr-reader pr-composer"
      aria-labelledby="pr-composer-title"
      data-compose-mode={draft.mode}
      data-in-reply-to={state.inReplyTo ?? ''}
      data-references={state.references.join(' ')}
      data-source-id={draft.sourceId ?? ''}
      data-forward-of={state.forwardOf ?? ''}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDiscard(); // closes; the unmount keeps an unsaved draft
        }
      }}
    >
      {back}
      <Stack
        as="form"
        gap="16"
        noValidate
        aria-busy={sending}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <h2 id="pr-composer-title" className="pr-reader__subject">
          {TITLES[draft.mode]}
        </h2>
        {error !== null ? (
          <Alert tone="danger" dynamic>
            {error}
          </Alert>
        ) : null}
        <FormField label="To">
          <Input ref={toRef} value={state.to} autoComplete="off" onChange={(e) => { edit({ to: e.target.value }); }} />
        </FormField>
        <FormField label="Cc" optional>
          <Input value={state.cc} autoComplete="off" onChange={(e) => { edit({ cc: e.target.value }); }} />
        </FormField>
        <FormField label="Blind copy" optional help="Recipients here get the message but are not shown to anyone.">
          <Input value={state.bcc} autoComplete="off" onChange={(e) => { edit({ bcc: e.target.value }); }} />
        </FormField>
        <FormField label="Subject">
          <Input value={state.subject} onChange={(e) => { edit({ subject: e.target.value }); }} />
        </FormField>
        <FormField label="Message" {...(state.forwardOf !== null ? { help: 'The original message is attached in full.' } : {})}>
          <Textarea ref={bodyRef} rows={12} value={state.text} onChange={(e) => { edit({ text: e.target.value }); }} />
        </FormField>
        <FormField label="Remind me" optional help="If nobody replies in time, the message comes back to your Inbox.">
          <Select
            options={REMIND_CHOICES.map((c) => ({ value: c.seconds === null ? 'none' : String(c.seconds), label: c.label }))}
            value={remind === null ? 'none' : String(remind)}
            onValueChange={(v) => { setRemind(v === 'none' ? null : Number(v)); }}
          />
        </FormField>
        {timing.kind === 'later' ? (
          <FormField label="Send at" help="It waits in Drafts until then; you can cancel it there.">
            <Input type="datetime-local" value={timing.local} min={toLocalInput(new Date())} onChange={(e) => { setTiming({ kind: 'later', local: e.target.value }); }} />
          </FormField>
        ) : null}
        <FormActions
          leading={
            <Button type="button" variant="ghost" onClick={discard} disabled={sending}>
              Discard
            </Button>
          }
        >
          <Button type="button" variant="secondary" disabled={sending} onClick={() => void save(true)}>
            Save draft
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={sending}
            pressed={timing.kind === 'later'}
            onClick={() => {
              setTiming(timing.kind === 'later' ? { kind: 'now' } : { kind: 'later', local: toLocalInput(new Date(Date.now() + 3_600_000)) });
            }}
          >
            Send later
          </Button>
          <Button type="submit" variant="primary" loading={sending}>
            {timing.kind === 'later' ? 'Schedule' : 'Send'}
          </Button>
        </FormActions>
        <p className="pr-reader__note" role="status" aria-live="polite">
          {status}
        </p>
      </Stack>
    </section>
  );
}
