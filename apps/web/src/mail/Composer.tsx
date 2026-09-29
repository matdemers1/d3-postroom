// The composer (PST-T-3.11, PST-REQ-079): a new message, reply, reply-all or forward, prefilled by
// compose.ts; sent through the server's submission path (POST /api/compose/send), which files it in
// Sent and threads it; and kept as a draft in the Drafts mailbox while it is being written —
// autosaved a few seconds after the last keystroke and kept when the composer is closed with Escape.
//
// PST-T-14.7 (PST-REQ-191/192/193, PST-ADR-011; design audit TF-06..09, CPY-04, MOD-06/07) reshaped
// it around the operator's "composing a new mail just has too many fields all at once":
//   - it opens with To, Subject and the body only. To is a RecipientField row — chips, contact
//     autocomplete from the address book — with "Cc  Bcc" (and "From", when the account has masked
//     aliases to send as) revealing their rows on demand, height + opacity over --dur-2;
//   - Subject is a borderless row with its label beside it; the body has no box and fills the pane;
//   - the footer is the same everywhere: Send as a split button (▾ Send later…, a reminder, the undo
//     window), "Aa" for the formatting bar, ⋯ for the rare options (Markdown, read receipt, a
//     template, sign/encrypt), the draft's status, and Discard — which moves the draft to Trash
//     (PST-T-14.1) and offers Undo in a toast that moves it back to Drafts;
//   - a new message or a resumed draft takes the reading pane's place (full-screen push below
//     768px); a reply or forward opens INLINE under the thread it answers (MailView mounts it in
//     ReadingPane's `composer` slot), with the quoted text folded behind "···";
//   - it arrives sliding up 12px and fading in over --dur-3; none of this moves under reduced motion.
//
// There is no Attach: the compose API takes no uploads (a forward attaches the original whole).
//
// A draft is picked up again when the same composer reopens: a reply, reply-all or forward finds the
// draft it left for the same message; a draft opened from Drafts (`?compose=draft`, or Edit draft on
// its toolbar) is resumed in place.
//
// After sending, the composer closes back to the message it answered (PST-T-3.15): the server has
// already filed and threaded the reply by the time send() resolves, so the open thread there shows
// it without a reload. The mailbox list updates over SSE.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Alert,
  Button,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  RecipientField,
  Select,
  Textarea,
  Tooltip,
  useToast,
  type RecipientLoader,
} from '@d3cloud/ui';
import { api, ApiError, contactsApi, type Alias, type ComposeKind, type DraftInput, type SavedDraft } from '../api';
import { templatesApi, type TemplateJson } from '../compose/api';
import { discardDraft, draftsOf, restoreDraft, trashOf, type DiscardOutcome } from './discard';
import { keysApi, type CryptoKeyJson, type KeyKind } from '../keys/api';
import { cryptoAvailability, cryptoRequest, recipientAddresses } from '../keys/format';
import {
  applyTemplate,
  fieldsOf,
  hasRecipients,
  initialState,
  isHeld,
  isSendChord,
  matchingTemplates,
  REMIND_CHOICES,
  resumableDraft,
  sendErrorText,
  sendExtra,
  sendOptions,
  SEND_CHORD_HINT,
  stateFromSaved,
  templateTrigger,
  toLocalInput,
  undoSeconds,
  setUndoSeconds,
  UNDO_CHOICES,
  type ComposeDraft,
  type ComposeState,
  type SendTiming,
} from './compose';
import { applyFormat, FORMAT_LABELS, initialReveal, joinQuote, optionsSummary, reveal as revealRow, splitQuote, type FormatAction, type Reveal } from './compose/fields';
import { contactSuggestions, fromChoices, fromRecipients, hasFromChoice, toRecipients } from './compose/recipients';
import { composerKey, forgetDrafts, linkSavedDraft } from './compose/session';
import { FormatIcon, TrashIcon } from './compose/icons';
import { SecurityModal } from './compose/SecurityModal';
import { CaretIcon, MoreIcon } from './thread/icons';
import { useMail } from './MailContext';
import { parseMailRoute } from './route';
import { announceHeld } from './Scheduled';
import './compose/composer.css';

/** The browser's storage, or null where there is none (a locked-down profile). */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const TITLES: Readonly<Record<ComposeKind, string>> = {
  new: 'New message',
  reply: 'Reply',
  replyall: 'Reply all',
  forward: 'Forward',
};

/** How long after the last change a draft is saved on its own. */
export const AUTOSAVE_MS = 3000;

type SaveStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: string } | { kind: 'failed' };

/** Options revealed from the Send menu, each one row above the footer. */
interface SendRows {
  remind: boolean;
  undo: boolean;
}

const FORMAT_ACTIONS: readonly FormatAction[] = ['bold', 'italic', 'link', 'list', 'quote'];

/** Short, calm: "Saved just now", "Saved 2:14 PM". */
function savedText(at: string, now = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime()) || now.getTime() - d.getTime() < 60_000) return 'Saved just now';
  return `Saved ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export interface ComposerProps {
  draft: ComposeDraft;
  /** `pane` takes the reading pane's place (new, resumed draft); `inline` sits under the thread it answers. */
  placement?: 'pane' | 'inline';
  /** Closes the composer (Escape, Send, Discard). */
  onDiscard: () => void;
  /** Where the draft went after Discard (and after its Undo), said by the view that outlives the composer. */
  onDiscarded?: (outcome: DiscardOutcome) => void;
  /** Sent (or held to send): an inline reply's thread asks the server again, so the reply joins it. */
  onSent?: () => void;
  /** A resumed draft was saved under a new id (a save replaces the draft): the view moves its URL on. */
  onDraftSaved?: (id: string) => void;
  back?: ReactNode;
}

export function Composer({ draft, placement = 'pane', onDiscard, onDiscarded, onSent, onDraftSaved, back }: ComposerProps) {
  const { me, mailboxes, refreshMailboxes } = useMail();
  const toast = useToast();
  const location = useLocation();
  const uid = useId();
  const [state, setState] = useState<ComposeState>(() => initialState(draft));
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [resumed, setResumed] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What this composer is: its opener's, or — for a draft opened from Drafts — the saved draft's own.
  const [kind, setKind] = useState<ComposeKind>(draft.mode);
  const [loadingDraft, setLoadingDraft] = useState(draft.resumeId !== undefined && draft.resumeId !== null);
  // PST-REQ-191: Cc, Bcc and From on demand.
  const [rows, setRows] = useState<Reveal>(() => initialReveal(initialState(draft)));
  const [from, setFrom] = useState<string | null>(null);
  const [aliases, setAliases] = useState<Alias[]>([]);
  // The quote of a reply or forward, folded until asked for (MOD-07).
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [formatBar, setFormatBar] = useState(false);
  // PST-T-9.1: send later (PST-REQ-141) and remind if no reply (PST-REQ-143).
  const [timing, setTiming] = useState<SendTiming>({ kind: 'now' });
  const [remind, setRemind] = useState<number | null>(null);
  const [sendRows, setSendRows] = useState<SendRows>({ remind: false, undo: false });
  // PST-REQ-140: the undo window is the person's choice, remembered in this browser.
  const [undo, setUndo] = useState<number>(() => undoSeconds(storage()));
  // PST-T-12.2 (PST-REQ-161): Sign / Encrypt with the account's keys, offered when the keys exist.
  const [keys, setKeys] = useState<CryptoKeyJson[] | null>(null);
  const [cryptoKind, setCryptoKind] = useState<KeyKind>('pgp');
  const [signOn, setSignOn] = useState(false);
  const [encryptOn, setEncryptOn] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const toRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLElement>(null);

  // PST-T-9.2: saved templates via the ; shortcut (PST-REQ-144).
  const [templates, setTemplates] = useState<TemplateJson[] | null>(null);
  const [picker, setPicker] = useState<{ start: number; end: number; shortcut: string } | null>(null);

  // Everything a timer, an unmount or a queued save needs, current.
  const latest = useRef(state);
  latest.current = state;
  const draftId = useRef<string | null>(null);
  const identity = useRef<{ mode: ComposeKind; sourceId: string | null }>({ mode: draft.mode, sourceId: draft.sourceId });
  /** Bumped on every edit; a save records the version it wrote, so "dirty" is version !== saved. */
  const version = useRef(0);
  const savedVersion = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finished = useRef(false);
  const mounted = useRef(true);
  // The key MailView mounted this composer under; every id it saves maps back to it (compose/session).
  const [ownKey] = useState(() => composerKey(draft));

  const sender = from ?? me;
  const senderRef = useRef(sender);
  senderRef.current = sender;

  const edit = (patch: Partial<ComposeState>) => {
    version.current += 1;
    setState((s) => ({ ...s, ...patch }));
  };

  // --- The body, with its quote folded -------------------------------------------------------------
  const split = splitQuote(state.text);
  const folded = !quoteOpen && split.quote !== '';
  const shownBody = folded ? split.head : state.text;
  /** The text of the whole body, given what the textarea now shows. */
  const wholeBody = (shown: string): string => (folded ? joinQuote(shown, split.quote) : shown);

  /** The body changed: check whether the cursor now sits right after a `;shortcut` (PST-REQ-144). */
  const onBodyChange = (shown: string, cursor: number) => {
    edit({ text: wholeBody(shown) });
    const trigger = templateTrigger(shown, cursor);
    if (trigger === null) {
      setPicker(null);
      return;
    }
    setPicker(trigger);
    if (templates === null) void templatesApi.list().then((r) => { setTemplates(r.templates); }).catch(() => { setTemplates([]); });
  };

  const chooseTemplate = (template: TemplateJson) => {
    if (picker === null) return;
    const displayName = me === null ? '' : me.split('@')[0] ?? '';
    const vars = { name: displayName, first_name: displayName.split(/[.\s_-]/)[0] ?? displayName, date: new Date().toLocaleDateString() };
    // The picker's positions are in the shown body, which is a prefix of the whole one.
    const result = applyTemplate(latest.current.text, picker, template, vars);
    const patch: Partial<ComposeState> = { text: result.text };
    if (template.subject !== null && latest.current.subject === '') patch.subject = template.subject;
    edit(patch);
    setPicker(null);
    requestAnimationFrame(() => {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(result.cursor, result.cursor);
    });
  };

  /** ⋯ Insert template: a `;` at the cursor, which opens the same picker as typing it. */
  const insertTemplate = () => {
    const el = bodyRef.current;
    const shown = el?.value ?? shownBody;
    const at = el?.selectionStart ?? shown.length;
    const needsSpace = at > 0 && !/\s/.test(shown.charAt(at - 1));
    const insert = `${needsSpace ? ' ' : ''};`;
    const next = shown.slice(0, at) + insert + shown.slice(at);
    onBodyChange(next, at + insert.length);
    requestAnimationFrame(() => {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(at + insert.length, at + insert.length);
    });
  };

  /** The formatting bar: Markdown around the selection, and the message becomes Markdown. */
  const format = (action: FormatAction) => {
    const el = bodyRef.current;
    if (el === null) return;
    const result = applyFormat(el.value, el.selectionStart, el.selectionEnd, action);
    edit({ text: wholeBody(result.text), format: 'markdown' });
    requestAnimationFrame(() => {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(result.start, result.end);
    });
  };

  // --- What the account has: keys, masked aliases ---------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    keysApi
      .list()
      .then(({ keys: list }) => {
        if (cancelled) return;
        setKeys(list);
        // Offer the kind the person actually has a key of.
        const ownKinds = new Set(list.filter((k) => k.owner === 'own' && k.revokedAt === null).map((k) => k.kind));
        if (!ownKinds.has('pgp') && ownKinds.has('smime')) setCryptoKind('smime');
      })
      .catch(() => {
        if (!cancelled) setKeys([]);
      });
    api
      .aliases()
      .then(({ aliases: list }) => {
        if (!cancelled) setAliases(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const recipients = recipientAddresses(state);
  const availability = cryptoAvailability(keys ?? [], cryptoKind, recipients);
  const choices = fromChoices(me, aliases);
  if (sender !== null && !choices.includes(sender)) choices.push(sender);
  const canChooseFrom = hasFromChoice(choices);

  const templateMatches = picker === null || templates === null ? [] : matchingTemplates(templates, picker.shortcut);

  // Contact autocomplete (TF-07): the address book, searched by what has been typed.
  const loadSuggestions = useCallback<RecipientLoader>(async (query) => {
    try {
      const { contacts } = await contactsApi.list({ q: query });
      return contactSuggestions(contacts, query);
    } catch {
      return [];
    }
  }, []);

  const draftInput = (s: ComposeState): DraftInput => ({
    ...fieldsOf(s),
    ...(senderRef.current === null ? {} : { from: senderRef.current }),
    mode: identity.current.mode,
    sourceId: identity.current.sourceId,
  });
  const draftInputRef = useRef(draftInput);
  draftInputRef.current = draftInput;
  const onDraftSavedRef = useRef(onDraftSaved);
  onDraftSavedRef.current = onDraftSaved;

  /** Save now (queued behind any save in flight). Resolves when this save has settled. `force` saves
   *  even an untouched prefill; `evenIfFinished` lets Discard save what was typed before trashing it. */
  const save = useCallback((force = false, evenIfFinished = false): Promise<void> => {
    const run = async () => {
      if ((finished.current && !evenIfFinished) || (!force && version.current === savedVersion.current)) return;
      const at = version.current;
      const input = draftInputRef.current(latest.current);
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
        // The URL moves on to the draft's new id (a reload resumes it), and this composer stays.
        if (mounted.current && !finished.current) {
          linkSavedDraft(ownKey, saved.id);
          onDraftSavedRef.current?.(saved.id);
        }
      } catch {
        setSaveStatus({ kind: 'failed' });
      }
    };
    const next = chain.current.then(run);
    chain.current = next.catch(() => undefined);
    return next;
    // The draft this composer was opened with never changes (MailView keys the composer by it).
  }, []);

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
  }, [state, from, save]);

  // Closing the composer any way but Discard or Send keeps what was typed.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      forgetDrafts(ownKey);
      cancelTimer();
      if (!finished.current && version.current !== savedVersion.current) void save();
    };
  }, [save, ownKey]);

  // Pick up a draft this composer left before, or the one it was opened for.
  useEffect(() => {
    let cancelled = false;
    const apply = (saved: SavedDraft) => {
      if (cancelled || version.current !== 0) return; // never over what the person already typed
      draftId.current = saved.id;
      const next = stateFromSaved(saved);
      setState(next);
      setRows((r) => {
        const opened = initialReveal(next, saved.from, me);
        return { cc: r.cc || opened.cc, bcc: r.bcc || opened.bcc, from: r.from || opened.from };
      });
      if (saved.from !== '' && me !== null && saved.from.toLowerCase() !== me.toLowerCase()) setFrom(saved.from);
      setResumed(true);
    };
    const resumeId = draft.resumeId ?? null;
    const messageId = parseMailRoute(location.pathname, location.search)?.messageId ?? null;
    if (resumeId !== null) {
      // Opened from Drafts: this draft, in place, with what it was (a reply stays a reply).
      api
        .draft(resumeId)
        .then((saved) => {
          if (cancelled) return;
          identity.current = { mode: saved.mode ?? 'new', sourceId: saved.sourceId };
          setKind(saved.mode ?? 'new');
          apply(saved);
        })
        .catch(() => {
          if (!cancelled) setError('This draft could not be opened. It may have been sent or discarded on another device.');
        })
        .finally(() => {
          if (!cancelled) setLoadingDraft(false);
        });
    } else if (draft.mode === 'new' && messageId !== null) {
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

  // A reply already knows who it is for: start in the text, at the top, above the quote. An inline
  // reply is scrolled into view under the thread.
  useEffect(() => {
    if (placement === 'inline') rootRef.current?.scrollIntoView({ block: 'nearest' });
    if (draft.to === '' && (draft.resumeId ?? null) === null) toRef.current?.focus();
    else {
      bodyRef.current?.focus({ preventScroll: placement === 'inline' });
      bodyRef.current?.setSelectionRange(0, 0);
    }
  }, [draft.to, draft.resumeId, placement]);

  const send = async () => {
    setError(null);
    if (!hasRecipients(latest.current)) {
      setError('Add at least one recipient.');
      toRef.current?.focus();
      return;
    }
    if (sender === null) {
      setError('Your account has no address to send from.');
      return;
    }
    const timed = sendOptions(timing, undo, remind, new Date());
    if (!timed.ok) {
      setError(timed.error);
      return;
    }
    setSending(true);
    cancelTimer();
    // Let a save in flight land first, so the draft it made is the one the send removes.
    await chain.current;
    try {
      const crypto = cryptoRequest(cryptoKind, signOn, encryptOn, availability);
      const body: Parameters<typeof api.sendOrHold>[0] & ReturnType<typeof sendExtra> & { crypto?: typeof crypto } = {
        ...fieldsOf(latest.current),
        from: sender,
        draftId: draftId.current,
        ...timed.options,
        ...sendExtra(latest.current),
        ...(crypto === undefined ? {} : { crypto }),
      };
      const result = await api.sendOrHold(body);
      // Held (undo window or scheduled): the toast outside the composer offers Undo (PST-REQ-140).
      if (isHeld(result)) announceHeld(result);
      finished.current = true;
      void refreshMailboxes();
      // The server has already filed and threaded the reply: closing back to the message it
      // answered shows it there, in the open thread, without a reload (PST-T-3.15).
      onSent?.();
      onDiscard();
      return;
    } catch (e) {
      setError(sendErrorText(e));
    } finally {
      setSending(false);
    }
  };

  const discard = () => {
    const dirty = version.current !== savedVersion.current;
    const s = latest.current;
    const hasContent = s.to.trim() !== '' || s.cc.trim() !== '' || s.bcc.trim() !== '' || s.subject.trim() !== '' || s.text.trim() !== '';
    finished.current = true;
    cancelTimer();
    const trash = trashOf(mailboxes);
    const drafts = draftsOf(mailboxes);
    // What was typed and not yet saved is saved first, so Undo has something to bring back; then
    // it moves to Trash — never deleted (PST-REQ-129).
    const pending = dirty && hasContent ? save(true, true) : Promise.resolve();
    void pending
      .then(() => chain.current)
      .then(async () => {
        const outcome = await discardDraft(api, draftId.current, trash);
        void refreshMailboxes();
        onDiscarded?.(outcome);
        if (outcome.kind !== 'trashed') return;
        const trashedId = outcome.trashedId;
        toast.show({
          message: outcome.text,
          action: {
            label: 'Undo',
            onAction: () => {
              void restoreDraft(api, trashedId, drafts).then((back) => {
                void refreshMailboxes();
                onDiscarded?.(back);
                toast.show({ message: back.text });
              });
            },
          },
        });
      });
    onDiscard();
  };

  const status = loadingDraft
    ? 'Opening your draft…'
    : saveStatus.kind === 'saving'
      ? 'Saving…'
      : saveStatus.kind === 'saved'
        ? savedText(saveStatus.at)
        : saveStatus.kind === 'failed'
          ? 'Not saved — retrying as you type'
          : resumed
            ? 'Picked up your saved draft.'
            : '';
  const summary = optionsSummary({ markdown: state.format === 'markdown', receipt: state.requestReceipt, sign: signOn, encrypt: encryptOn, remind: remind !== null });

  const title = loadingDraft ? 'Draft' : TITLES[kind];
  const titleId = `${uid}-title`;
  const subjectId = `${uid}-subject`;
  const fromId = `${uid}-from`;
  const HeadingTag = placement === 'inline' ? 'h3' : 'h2';

  const revealButtons = (
    <span className="pr-compose__reveals">
      {!rows.cc ? (
        <Tooltip content="Copy someone in">
          <Button type="button" size="sm" variant="ghost" className="pr-compose__reveal-link" onClick={() => { setRows((r) => revealRow(r, 'cc')); }}>
            Cc
          </Button>
        </Tooltip>
      ) : null}
      {!rows.bcc ? (
        <Tooltip content="Recipients here get the message but are not shown to anyone">
          <Button type="button" size="sm" variant="ghost" className="pr-compose__reveal-link" onClick={() => { setRows((r) => revealRow(r, 'bcc')); }}>
            Bcc
          </Button>
        </Tooltip>
      ) : null}
      {canChooseFrom && !rows.from ? (
        <Tooltip content="Send as one of your aliases">
          <Button type="button" size="sm" variant="ghost" className="pr-compose__reveal-link" onClick={() => { setRows((r) => revealRow(r, 'from')); }}>
            From
          </Button>
        </Tooltip>
      ) : null}
    </span>
  );

  return (
    <section
      ref={rootRef}
      className={placement === 'inline' ? 'pr-compose pr-compose--inline' : 'pr-reader pr-compose pr-compose--pane'}
      aria-labelledby={titleId}
      data-compose-mode={kind}
      data-placement={placement}
      data-in-reply-to={state.inReplyTo ?? ''}
      data-references={state.references.join(' ')}
      data-source-id={identity.current.sourceId ?? ''}
      data-forward-of={state.forwardOf ?? ''}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Escape that closes a suggestion list, a menu or a dialog stops there.
          const target = e.target as HTMLElement;
          if (e.defaultPrevented || target.getAttribute('aria-expanded') === 'true' || target.closest('[role="menu"], [role="dialog"], [role="listbox"]') !== null) return;
          e.stopPropagation();
          onDiscard(); // closes; the unmount keeps an unsaved draft
          return;
        }
        // PST-T-11.4: ⌘↵ / Ctrl+Enter sends from any field, through the same path (and the same
        // undo window) as the Send button.
        if (isSendChord(e)) {
          e.preventDefault();
          e.stopPropagation();
          if (!sending) void send();
        }
      }}
    >
      {back}
      <form
        className="pr-compose__form"
        noValidate
        aria-busy={sending || loadingDraft}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <HeadingTag id={titleId} className={placement === 'inline' ? 'pr-compose__title pr-compose__title--inline' : 'pr-compose__title'}>
          {title}
        </HeadingTag>
        {error !== null ? (
          <Alert tone="danger" dynamic>
            {error}
          </Alert>
        ) : null}
        <div className="pr-compose__rows">
          <RecipientField
            ref={toRef}
            variant="row"
            label="To"
            value={toRecipients(state.to)}
            onValueChange={(next) => { edit({ to: fromRecipients(next) }); }}
            loadSuggestions={loadSuggestions}
            trailing={revealButtons}
          />
          {rows.cc ? (
            <div className="pr-compose__reveal" data-row="cc">
              <RecipientField
                variant="row"
                label="Cc"
                autoFocus={state.cc === ''}
                value={toRecipients(state.cc)}
                onValueChange={(next) => { edit({ cc: fromRecipients(next) }); }}
                loadSuggestions={loadSuggestions}
              />
            </div>
          ) : null}
          {rows.bcc ? (
            <div className="pr-compose__reveal" data-row="bcc">
              <RecipientField
                variant="row"
                label="Bcc"
                autoFocus={state.bcc === ''}
                value={toRecipients(state.bcc)}
                onValueChange={(next) => { edit({ bcc: fromRecipients(next) }); }}
                loadSuggestions={loadSuggestions}
              />
            </div>
          ) : null}
          {rows.from && canChooseFrom ? (
            <div className="pr-compose__reveal pr-compose__row" data-row="from">
              <label className="pr-compose__label" htmlFor={fromId}>
                From
              </label>
              <Select
                appearance="filled"
                id={fromId}
                className="pr-compose__from"
                options={choices.map((address) => ({ value: address, label: address }))}
                value={sender ?? ''}
                onValueChange={(v) => {
                  version.current += 1;
                  setFrom(v === me ? null : v);
                }}
              />
            </div>
          ) : null}
          <div className="pr-compose__row" data-row="subject">
            <label className="pr-compose__label" htmlFor={subjectId}>
              Subject
            </label>
            <Input appearance="filled" id={subjectId} className="pr-compose__subject" value={state.subject} onChange={(e) => { edit({ subject: e.target.value }); }} />
          </div>
        </div>
        {formatBar ? (
          <div role="toolbar" aria-label="Formatting" className="pr-compose__formatbar pr-compose__reveal">
            {FORMAT_ACTIONS.map((a) => (
              <Button key={a} type="button" size="sm" variant="ghost" onClick={() => { format(a); }}>
                {FORMAT_LABELS[a]}
              </Button>
            ))}
            <span className="pr-compose__hint">Written as Markdown, sent as formatted text alongside plain text.</span>
          </div>
        ) : null}
        <Textarea
          appearance="filled"
          ref={bodyRef}
          aria-label="Message"
          className="pr-compose__body"
          rows={placement === 'inline' ? 6 : 12}
          value={shownBody}
          onChange={(e) => { onBodyChange(e.target.value, e.target.selectionStart); }}
        />
        {picker !== null && templateMatches.length > 0 ? (
          <ul className="pr-compose__templates" role="listbox" aria-label="Matching templates">
            {templateMatches.map((t) => (
              <li key={t.id}>
                <Button type="button" variant="ghost" size="sm" onClick={() => { chooseTemplate(t); }}>
                  ;{t.shortcut} — {t.name}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {folded ? (
          <div className="pr-compose__quote">
            <Tooltip content="Show quoted text">
              <Button type="button" size="sm" variant="secondary" aria-expanded={false} aria-label="Show quoted text" onClick={() => { setQuoteOpen(true); }}>
                ···
              </Button>
            </Tooltip>
          </div>
        ) : null}
        {state.forwardOf !== null ? <p className="pr-compose__hint">The original message is attached in full.</p> : null}
        {timing.kind === 'later' ? (
          <div className="pr-compose__row pr-compose__reveal" data-row="send-at">
            <label className="pr-compose__label" htmlFor={`${uid}-at`}>
              Send at
            </label>
            <Input
              appearance="filled"
              id={`${uid}-at`}
              type="datetime-local"
              value={timing.local}
              min={toLocalInput(new Date())}
              onChange={(e) => { setTiming({ kind: 'later', local: e.target.value }); }}
            />
            <span className="pr-compose__hint">It waits in Drafts until then; you can cancel it there.</span>
          </div>
        ) : null}
        {sendRows.remind ? (
          <div className="pr-compose__row pr-compose__reveal" data-row="remind">
            <label className="pr-compose__label" htmlFor={`${uid}-remind`}>
              Remind me
            </label>
            <Select
              appearance="filled"
              id={`${uid}-remind`}
              options={REMIND_CHOICES.map((c) => ({ value: c.seconds === null ? 'none' : String(c.seconds), label: c.label }))}
              value={remind === null ? 'none' : String(remind)}
              onValueChange={(v) => { setRemind(v === 'none' ? null : Number(v)); }}
            />
            <span className="pr-compose__hint">If nobody replies in time, the message comes back to your Inbox.</span>
          </div>
        ) : null}
        {sendRows.undo && timing.kind === 'now' ? (
          <div className="pr-compose__row pr-compose__reveal" data-row="undo">
            <label className="pr-compose__label" htmlFor={`${uid}-undo`}>
              Undo send
            </label>
            <Select
              appearance="filled"
              id={`${uid}-undo`}
              options={UNDO_CHOICES.map((seconds) => ({ value: String(seconds), label: seconds === 0 ? 'Off — send at once' : `${String(seconds)} seconds` }))}
              value={String(undo)}
              onValueChange={(v) => {
                const seconds = Number(v);
                setUndo(seconds);
                setUndoSeconds(storage(), seconds);
              }}
            />
          </div>
        ) : null}
        {/* One footer everywhere (TF-06): Send ▾, Aa, ⋯ … status, Discard. */}
        <div className="pr-compose__footer">
          <div className="pr-compose__send" role="group" aria-label="Send options">
            <Button type="submit" variant="primary" loading={sending} disabled={loadingDraft} title={`${timing.kind === 'later' ? 'Schedule' : 'Send'} (${SEND_CHORD_HINT})`}>
              {timing.kind === 'later' ? 'Schedule' : 'Send'}
            </Button>
            <Menu>
              <MenuTrigger>
                <IconButton variant="secondary" label="More ways to send" icon={<CaretIcon />} disabled={sending} className="pr-compose__send-more" />
              </MenuTrigger>
              <MenuContent align="start" side="top">
                {timing.kind === 'later' ? (
                  <MenuItem onSelect={() => { setTiming({ kind: 'now' }); }}>Send now instead</MenuItem>
                ) : (
                  <MenuItem onSelect={() => { setTiming({ kind: 'later', local: toLocalInput(new Date(Date.now() + 3_600_000)) }); }}>Send later…</MenuItem>
                )}
                <MenuItem onSelect={() => { setSendRows((r) => ({ ...r, remind: true })); }}>Remind me if no reply…</MenuItem>
                {timing.kind === 'now' ? <MenuItem onSelect={() => { setSendRows((r) => ({ ...r, undo: true })); }}>Undo send window…</MenuItem> : null}
              </MenuContent>
            </Menu>
          </div>
          <Tooltip content="Formatting">
            <IconButton variant="ghost" label="Formatting" icon={<FormatIcon />} pressed={formatBar} onClick={() => { setFormatBar((on) => !on); }} />
          </Tooltip>
          <Menu>
            <MenuTrigger>
              <IconButton variant="ghost" label="More options" icon={<MoreIcon />} />
            </MenuTrigger>
            <MenuContent align="start" side="top">
              <MenuItem onSelect={() => { edit({ format: state.format === 'markdown' ? 'plain' : 'markdown' }); }}>
                {state.format === 'markdown' ? 'Write in plain text' : 'Write in Markdown'}
              </MenuItem>
              <MenuItem onSelect={() => { edit({ requestReceipt: !state.requestReceipt }); }}>
                {state.requestReceipt ? 'Stop requesting a read receipt' : 'Request read receipt'}
              </MenuItem>
              <MenuItem onSelect={insertTemplate}>Insert template…</MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={() => { setSecurityOpen(true); }}>Sign or encrypt…</MenuItem>
            </MenuContent>
          </Menu>
          <p className="pr-compose__status" role="status" aria-live="polite" data-testid="compose-status">
            {summary !== '' ? <span className="pr-compose__summary">{summary}</span> : null}
            <span>{status}</span>
          </p>
          <Button type="button" variant="ghost" icon={<TrashIcon />} onClick={discard} disabled={sending} className="pr-compose__discard">
            Discard
          </Button>
        </div>
      </form>
      <SecurityModal
        open={securityOpen}
        onOpenChange={setSecurityOpen}
        loaded={keys !== null}
        kind={cryptoKind}
        onKind={setCryptoKind}
        sign={signOn}
        onSign={setSignOn}
        encrypt={encryptOn}
        onEncrypt={setEncryptOn}
        availability={availability}
      />
    </section>
  );
}
