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
// PST-T-15.4 (PST-REQ-194) draws it to the redesign canvas (Compose.dc.html): a header — the title,
// then Minimise, Open full screen and Close — over borderless To and Subject rows, a body with no
// box, and one quiet action bar: Send as the library's SplitButton (▾ Send later…, a reminder, the
// undo window), Formatting, Insert link, ⋯ More (Markdown, read receipt, a template, sign/encrypt),
// then "Draft saved" and Discard on the right. Minimise and full screen are this composer's own view
// (nothing is closed or saved differently); Close is Escape's path, which keeps an unsaved draft.
//
// PST-T-15.8 (PST-REQ-194) draws the phone to the canvas's PhoneCompose: below 768 px a new message
// or a resumed draft is a full-height sheet whose bar is Cancel (Escape's path, which keeps the
// draft), the title, and a round Send — the same submit as the split button, which the sheet does not
// draw. Send later…, the reminder and the undo window move into ⋯ More there, so none is lost.
//
// PST-T-15.11 (PST-REQ-195, PST-ADR-013) adds attachments: the canvas's paperclip, Attach files,
// before Formatting in the action bar (on the phone's sheet too — the same bar, its targets 44 px),
// opening a multi-file picker; files dropped anywhere on the composer (a "Drop to attach" target
// shows while they are dragged over it) or pasted into the body attach the same way. Each file
// uploads on its own with progress and becomes a chip under the body — where the reading pane shows
// a message's attachments, under its text — with Remove, and Retry when it failed. A file past the
// limit, or one that would take the set past the total or the count (GET /api/compose/limits), is
// refused before any request. Draft saves and the send carry the held uploads' ids; a draft opened
// again shows its attachments. Send is DISABLED while a file is uploading (⌘↵ says why), and a failed
// upload blocks it with a message until it is retried or removed. The rules are pure, in
// compose/attachments/state.ts; the XHR is compose/attachments/upload.ts.
//
// A draft is picked up again when the same composer reopens: a reply, reply-all or forward finds the
// draft it left for the same message; a draft opened from Drafts (`?compose=draft`, or Edit draft on
// its toolbar) is resumed in place.
//
// After sending, the composer closes back to the message it answered (PST-T-3.15): the server has
// already filed and threaded the reply by the time send() resolves, so the open thread there shows
// it without a reload. The mailbox list updates over SSE.
import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
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
  SplitButton,
  Textarea,
  Tooltip,
  useToast,
  type RecipientLoader,
} from '@d3cloud/ui';
import { api, ApiError, contactsApi, type Alias, type ComposeKind, type ComposeLimits, type DraftInput, type SavedDraft } from '../api';
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
import {
  applyFormat,
  composerClass,
  FORMAT_LABELS,
  initialReveal,
  joinQuote,
  optionsSummary,
  reveal as revealRow,
  saveStatusText,
  splitQuote,
  toggleView,
  viewLabels,
  type ComposerView,
  type FormatAction,
  type Reveal,
  type SaveStatus,
} from './compose/fields';
import { contactSuggestions, fromChoices, fromRecipients, hasFromChoice, toRecipients } from './compose/recipients';
import { composerKey, forgetDrafts, linkSavedDraft } from './compose/session';
import { CheckIcon, CloseIcon, CollapseIcon, ExpandIcon, FormatIcon, LinkIcon, MinimiseIcon, PaperclipIcon, RestoreIcon, TrashIcon } from './compose/icons';
import { AttachmentChips } from './compose/attachments/AttachmentChips';
import {
  admit,
  announceDone,
  announceFailed,
  announceStart,
  attachmentRefusalText,
  DEFAULT_LIMITS,
  dragHasFiles,
  failed as uploadFailed,
  fromSaved,
  newKey,
  progressed,
  removed,
  retrying,
  sendBlock,
  started,
  succeeded,
  uploadErrorText,
  uploadIds,
  uploading,
  type AttachmentItem,
} from './compose/attachments/state';
import { UploadAborted, uploadAttachment, type UploadHandle } from './compose/attachments/upload';
import { SecurityModal } from './compose/SecurityModal';
import { MoreIcon } from './thread/icons';
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

/** Options revealed from the Send menu, each one row above the footer. */
interface SendRows {
  remind: boolean;
  undo: boolean;
}

const FORMAT_ACTIONS: readonly FormatAction[] = ['bold', 'italic', 'link', 'list', 'quote'];

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
  /** The phone's full-height sheet (PST-T-15.8): Cancel, the title and a round Send in one bar. */
  sheet?: boolean;
}

/** The sheet's round Send: an arrow up (the canvas's .pr-csend). */
function SendArrow() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 12 7-7 7 7M12 19V5" />
    </svg>
  );
}

export function Composer({ draft, placement = 'pane', onDiscard, onDiscarded, onSent, onDraftSaved, sheet = false }: ComposerProps) {
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
  // PST-T-15.4: the header's Minimise / Open full screen — a view of this composer, nothing more.
  const [view, setView] = useState<ComposerView>({ minimised: false, expanded: false });
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

  // PST-T-15.11 (PST-REQ-195): attachments. The chips' state is changed only through applyItems(),
  // which keeps the ref (read by saves, sends and upload callbacks) and the render in step.
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const attachmentsRef = useRef<AttachmentItem[]>([]);
  const [limits, setLimits] = useState<ComposeLimits>(DEFAULT_LIMITS);
  const limitsRef = useRef(limits);
  limitsRef.current = limits;
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const fileByKey = useRef(new Map<string, File>());
  const handles = useRef(new Map<string, UploadHandle>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLButtonElement>(null);

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
    attachments: uploadIds(attachmentsRef.current),
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

  // Autosave: a few seconds after the last change — an attachment held or removed is a change;
  // upload progress is not.
  const heldIds = uploadIds(attachments).join(' ');
  useEffect(() => {
    if (version.current === savedVersion.current || finished.current) return;
    cancelTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      void save();
    }, AUTOSAVE_MS);
    return cancelTimer;
  }, [state, from, heldIds, save]);

  // Closing the composer any way but Discard or Send keeps what was typed.
  useEffect(() => {
    mounted.current = true;
    const inFlight = handles.current;
    return () => {
      mounted.current = false;
      forgetDrafts(ownKey);
      cancelTimer();
      // An upload still going when the composer closes is dropped; what was held is saved below.
      for (const h of inFlight.values()) h.abort();
      inFlight.clear();
      if (!finished.current && version.current !== savedVersion.current) void save();
    };
  }, [save, ownKey]);

  // The server's limits, for refusing before an upload (PST-REQ-195); its defaults if it cannot say.
  useEffect(() => {
    let cancelled = false;
    api
      .composeLimits()
      .then((l) => {
        if (!cancelled) setLimits(l);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const applyItems = (f: (items: AttachmentItem[]) => AttachmentItem[]) => {
    const next = f(attachmentsRef.current);
    if (next === attachmentsRef.current) return;
    attachmentsRef.current = next;
    setAttachments(next);
  };
  const applyItemsRef = useRef(applyItems);
  applyItemsRef.current = applyItems;

  /** Upload the file behind chip `key`; the chip follows its progress, and holds the id at the end. */
  const runUpload = (key: string) => {
    const file = fileByKey.current.get(key);
    if (file === undefined) return;
    const handle = uploadAttachment(file, (loaded) => {
      if (mounted.current) applyItemsRef.current((items) => progressed(items, key, loaded));
    });
    handles.current.set(key, handle);
    handle.done.then(
      (upload) => {
        handles.current.delete(key);
        // Removed while it uploaded, or the composer closed: nothing will send it, so let it go.
        if (!mounted.current || !attachmentsRef.current.some((a) => a.key === key)) {
          void api.deleteUpload(upload.id).catch(() => undefined);
          return;
        }
        fileByKey.current.delete(key);
        version.current += 1;
        applyItemsRef.current((items) => succeeded(items, key, upload));
        setAnnouncement(announceDone(upload.filename === '' ? file.name : upload.filename));
      },
      (e: unknown) => {
        handles.current.delete(key);
        if (e instanceof UploadAborted || !mounted.current) return;
        const reason = uploadErrorText(e);
        applyItemsRef.current((items) => uploadFailed(items, key, reason));
        setAnnouncement(announceFailed(file.name, reason));
      },
    );
  };

  /** Files from the picker, a drop or a paste: what fits is uploaded, what does not is refused first. */
  const addFiles = (list: FileList | readonly File[] | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    const { admitted, refusal } = admit(attachmentsRef.current, files, limitsRef.current);
    setAttachNote(refusal);
    if (admitted.length === 0) return;
    setAnnouncement(announceStart(admitted));
    const keys: string[] = [];
    applyItems((items) => {
      let next = items;
      for (const f of admitted) {
        const key = newKey();
        fileByKey.current.set(key, f);
        keys.push(key);
        next = started(next, key, f);
      }
      return next;
    });
    for (const key of keys) runUpload(key);
  };

  const removeAttachment = (key: string) => {
    const item = attachmentsRef.current.find((a) => a.key === key);
    if (item === undefined) return;
    handles.current.get(key)?.abort();
    handles.current.delete(key);
    fileByKey.current.delete(key);
    applyItems((items) => removed(items, key));
    setAttachNote(null);
    setAnnouncement(`${item.name} removed.`);
    if (item.kind === 'done') {
      version.current += 1;
      // After any save in flight that still names it, so that save never finds it gone.
      const id = item.id;
      void chain.current.then(() => api.deleteUpload(id)).catch(() => undefined);
    }
    // Its Remove button is gone: focus goes back to Attach files, not to the page.
    requestAnimationFrame(() => {
      attachRef.current?.focus();
    });
  };

  const retryAttachment = (key: string) => {
    const item = attachmentsRef.current.find((a) => a.key === key);
    if (item?.kind !== 'failed') return;
    applyItems((items) => retrying(items, key));
    setAnnouncement(announceStart([{ name: item.name, size: item.size, type: item.contentType }]));
    runUpload(key);
  };

  // Files dragged over the composer: one drop target over the whole of it while they are.
  const onDragEnter = (e: DragEvent) => {
    if (!dragHasFiles(e.dataTransfer.types)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDropping(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!dragHasFiles(e.dataTransfer.types)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: DragEvent) => {
    if (!dragHasFiles(e.dataTransfer.types)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropping(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!dragHasFiles(e.dataTransfer.types)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    setView((v) => (v.minimised ? { ...v, minimised: false } : v));
    addFiles(e.dataTransfer.files);
  };
  // Files pasted into the body attach; pasted text is left to the textarea.
  const onBodyPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length === 0) return;
    e.preventDefault();
    addFiles(e.clipboardData.files);
  };

  // Pick up a draft this composer left before, or the one it was opened for.
  useEffect(() => {
    let cancelled = false;
    const apply = (saved: SavedDraft) => {
      if (cancelled || version.current !== 0) return; // never over what the person already typed
      draftId.current = saved.id;
      const next = stateFromSaved(saved);
      setState(next);
      // PST-REQ-195: the draft's attachments, held again as uploads by the server.
      applyItemsRef.current((items) => [...fromSaved(saved.attachments), ...items]);
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
          if (found === null) return;
          // The list does not carry attachments; the draft itself does, so a save never drops them.
          if (found.attachments !== undefined) apply(found);
          else
            api
              .draft(found.id)
              .then(apply)
              .catch(() => {
                apply(found);
              });
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
    // PST-REQ-195: never send without a file the person attached.
    const blocked = sendBlock(attachmentsRef.current);
    if (blocked !== null) {
      setError(blocked);
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
        attachments: uploadIds(attachmentsRef.current),
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
      setError(attachmentRefusalText(e, limitsRef.current) ?? sendErrorText(e));
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
    for (const h of handles.current.values()) h.abort();
    handles.current.clear();
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

  const status = saveStatusText(saveStatus, { loadingDraft, resumed });
  const labels = viewLabels(view);
  const summary = optionsSummary({ markdown: state.format === 'markdown', receipt: state.requestReceipt, sign: signOn, encrypt: encryptOn, remind: remind !== null });

  const title = loadingDraft ? 'Draft' : TITLES[kind];
  // Send waits for every upload to land (PST-REQ-195): disabled while one is in flight.
  const busyUploading = uploading(attachments);
  const titleId = `${uid}-title`;
  const subjectId = `${uid}-subject`;
  const fromId = `${uid}-from`;
  const sheetId = `${uid}-sheet`;
  const HeadingTag = placement === 'inline' ? 'h3' : 'h2';
  const sendWord = timing.kind === 'later' ? 'Schedule' : 'Send';
  // Send later…, the reminder and the undo window: the split button's menu, or ⋯ More on the sheet.
  const sendMenuItems = (
    <>
      {timing.kind === 'later' ? (
        <MenuItem onSelect={() => { setTiming({ kind: 'now' }); }}>Send now instead</MenuItem>
      ) : (
        <MenuItem onSelect={() => { setTiming({ kind: 'later', local: toLocalInput(new Date(Date.now() + 3_600_000)) }); }}>Send later…</MenuItem>
      )}
      <MenuItem onSelect={() => { setSendRows((r) => ({ ...r, remind: true })); }}>Remind me if no reply…</MenuItem>
      {timing.kind === 'now' ? <MenuItem onSelect={() => { setSendRows((r) => ({ ...r, undo: true })); }}>Undo send window…</MenuItem> : null}
    </>
  );

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
      className={dropping ? `${composerClass(placement, view)} pr-compose--dropping` : composerClass(placement, view)}
      aria-labelledby={titleId}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
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
      <form
        className="pr-compose__form"
        noValidate
        aria-busy={sending || loadingDraft}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {sheet ? (
          /* The phone's sheet bar (PST-T-15.8): Cancel · the title · a round Send. */
          <div className="pr-compose__sheetbar">
            <Button type="button" variant="ghost" className="pr-compose__cancel" onClick={onDiscard}>
              Cancel
            </Button>
            <HeadingTag id={titleId} className="pr-compose__title pr-compose__title--sheet">
              {title}
            </HeadingTag>
            <IconButton type="submit" label={sendWord} icon={<SendArrow />} loading={sending} disabled={loadingDraft || busyUploading} className="pr-compose__sheetsend" />
          </div>
        ) : (
        /* The header (PST-T-15.4): the title, then Minimise, Open full screen and Close. */
        <div className="pr-compose__head">
          <HeadingTag id={titleId} className={placement === 'inline' ? 'pr-compose__title pr-compose__title--inline' : 'pr-compose__title'}>
            {title}
          </HeadingTag>
          <Tooltip content={labels.minimise}>
            <IconButton
              variant="ghost"
              size="sm"
              label={labels.minimise}
              icon={view.minimised ? <RestoreIcon /> : <MinimiseIcon />}
              aria-expanded={!view.minimised}
              aria-controls={sheetId}
              className="pr-compose__view"
              onClick={() => { setView((v) => toggleView(v, 'minimise')); }}
            />
          </Tooltip>
          <Tooltip content={labels.expand}>
            <IconButton
              variant="ghost"
              size="sm"
              label={labels.expand}
              icon={view.expanded ? <CollapseIcon /> : <ExpandIcon />}
              className="pr-compose__view"
              onClick={() => { setView((v) => toggleView(v, 'expand')); }}
            />
          </Tooltip>
          <Tooltip content="Close">
            <IconButton variant="ghost" size="sm" label="Close" icon={<CloseIcon />} onClick={onDiscard} />
          </Tooltip>
        </div>
        )}
        <div id={sheetId} className="pr-compose__sheet" hidden={view.minimised}>
          {error !== null ? (
            <Alert tone="danger" dynamic className="pr-compose__alert">
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
            onPaste={onBodyPaste}
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
          {state.forwardOf !== null ? <p className="pr-compose__hint pr-compose__note">The original message is attached in full.</p> : null}
          <AttachmentChips items={attachments} limits={limits} onRemove={removeAttachment} onRetry={retryAttachment} />
          {attachNote !== null ? (
            <Alert tone="warning" dynamic className="pr-attach__refusal">
              {attachNote}
            </Alert>
          ) : null}
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
          {/* One quiet action bar (PST-T-15.4): Send ▾ · Formatting · Insert link · More … Draft saved · Discard. */}
          <div className="pr-compose__footer">
            {sheet ? null : (
              <SplitButton
                type="submit"
                variant="primary"
                label={sendWord}
                menuLabel="More send options"
                loading={sending}
                disabled={loadingDraft || busyUploading}
                title={`${sendWord} (${SEND_CHORD_HINT})`}
                className="pr-compose__send"
              >
                {sendMenuItems}
              </SplitButton>
            )}
            <span className="pr-compose__tools">
              <Tooltip content="Attach files">
                <IconButton ref={attachRef} variant="ghost" label="Attach files" icon={<PaperclipIcon />} onClick={() => { fileInputRef.current?.click(); }} />
              </Tooltip>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                className="pr-attach__input"
                data-testid="compose-file-input"
                onChange={(e) => {
                  addFiles(e.target.files);
                  // The same file chosen again is a new change.
                  e.target.value = '';
                }}
              />
              <Tooltip content="Formatting">
                <IconButton variant="ghost" label="Formatting" icon={<FormatIcon />} pressed={formatBar} onClick={() => { setFormatBar((on) => !on); }} />
              </Tooltip>
              <Tooltip content="Insert link">
                <IconButton variant="ghost" label="Insert link" icon={<LinkIcon />} onClick={() => { format('link'); }} />
              </Tooltip>
              <Menu>
                <MenuTrigger>
                  <IconButton variant="ghost" label="More options" icon={<MoreIcon />} />
                </MenuTrigger>
                <MenuContent align="start" side="top">
                  {sheet ? (
                    <>
                      {sendMenuItems}
                      <MenuSeparator />
                    </>
                  ) : null}
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
            </span>
            <p className="pr-compose__status" role="status" aria-live="polite" data-testid="compose-status">
              {summary !== '' ? <span className="pr-compose__summary">{summary}</span> : null}
              {status !== '' ? (
                <span className="pr-compose__saved">
                  {saveStatus.kind === 'saved' && !loadingDraft ? <CheckIcon /> : null}
                  {status}
                </span>
              ) : null}
            </p>
            <Tooltip content="Discard draft">
              <IconButton variant="ghost" label="Discard draft" icon={<TrashIcon />} onClick={discard} disabled={sending} className="pr-compose__discard" />
            </Tooltip>
          </div>
        </div>
      </form>
      {/* Upload starts and ends, said once each — never every percent. */}
      <p className="pr-vh" role="status" aria-live="polite" data-testid="compose-attachment-announce">
        {announcement}
      </p>
      {dropping ? (
        <div className="pr-attach__drop" aria-hidden="true">
          Drop to attach
        </div>
      ) : null}
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
