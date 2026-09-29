// PST-T-14.5: the message list as a triage surface. Still ONE listbox of fixed-height rows,
// virtualised (only the rows in view plus an overscan are in the DOM, however long the mailbox —
// the 50k gate, PST-REQ-157), with the keyboard cursor as the active descendant so j/k move it
// without moving focus. Added around it, never inside a row:
//
//  - RowActions, one floating toolbar for the hovered / keyboard-cursor row (a sibling of the
//    listbox, so no option nests a control);
//  - the "N new" pill: mail arriving over SSE while you are scrolled down or pointing at the list
//    waits behind it instead of shifting the rows under the pointer.
//
// A row that is leaving (archived, deleted, moved) keeps its slot while its content fades and
// slides out on --motion-row-exit; MailView then drops it in one frame. Nothing animates layout.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import type { MessageSummary } from '../../api';
import { scrollToReveal, visibleRange } from '../list';
import { useMediaQuery } from '../useMedia';
import { MessageRow, ROW_HEIGHT, rowId } from './MessageRow';
import { RowActions } from './RowActions';
import { UpIcon } from './glyphs';

export type RowAction = 'archive' | 'delete' | 'snooze' | 'move';

export interface TriageListHandle {
  focus: () => void;
  /** At rest at the top, with the pointer elsewhere: a new arrival may go straight in. */
  isCalm: () => boolean;
  scrollToTop: () => void;
}

export interface TriageListProps {
  messages: MessageSummary[];
  cursor: number;
  openId: string | null;
  label: string;
  /** Selection mode when non-empty. */
  selected: ReadonlySet<string>;
  leaving: ReadonlySet<string>;
  /** The open message has a phishing warning: its row shows the address beside the name. */
  warnedId: string | null;
  pendingCount: number;
  canArchive: boolean;
  canTrash: boolean;
  canSnooze: boolean;
  onOpen: (message: MessageSummary, index: number) => void;
  onToggleSelect: (message: MessageSummary, index: number) => void;
  onRowAction: (action: RowAction, message: MessageSummary, index: number) => void;
  onShowNew: () => void;
  onNearEnd: () => void;
}

/** Where the action cluster sits inside a row (px from the row's top). */
const ACTIONS_INSET = 6;

export const TriageList = forwardRef<TriageListHandle, TriageListProps>(function TriageList(
  { messages, cursor, openId, label, selected, leaving, warnedId, pendingCount, canArchive, canTrash, canSnooze, onOpen, onToggleSelect, onRowAction, onShowNew, onNearEnd },
  ref,
) {
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const [hover, setHover] = useState<number | null>(null);
  const [listFocused, setListFocused] = useState(false);
  // The cursor row's cluster is for the KEYBOARD: shown when the list has keyboard focus, not when a
  // tap or click merely focused it (it would appear under the finger between press and release).
  const [keyboard, setKeyboard] = useState(false);
  // Hover reveals the cluster only for a real hovering pointer; on touch it would cover the row.
  const canHover = useMediaQuery('(hover: hover) and (pointer: fine)');
  const [barFocused, setBarFocused] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  const pointerInside = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => box.current?.focus(),
      isCalm: () => !pointerInside.current && (box.current?.scrollTop ?? 0) < ROW_HEIGHT / 2,
      scrollToTop: () => {
        const el = box.current;
        if (el === null) return;
        el.scrollTop = 0;
        setScroll({ top: 0, height: el.clientHeight });
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    const measure = () => {
      setScroll({ top: el.scrollTop, height: el.clientHeight });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);

  // Keep the cursor row in view as j/k move it.
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null || cursor < 0) return;
    const next = scrollToReveal(cursor, el.scrollTop, el.clientHeight, ROW_HEIGHT);
    if (next !== null) {
      el.scrollTop = next;
      setScroll({ top: next, height: el.clientHeight });
    }
  }, [cursor]);

  const { start, end } = visibleRange(scroll.top, scroll.height, ROW_HEIGHT, messages.length);

  useEffect(() => {
    if (messages.length > 0 && end >= messages.length - 5) onNearEnd();
  }, [end, messages.length, onNearEnd]);

  const indexAt = useCallback((clientY: number): number | null => {
    const el = box.current;
    if (el === null) return null;
    const y = clientY - el.getBoundingClientRect().top + el.scrollTop;
    const i = Math.floor(y / ROW_HEIGHT);
    return i >= 0 && i < messages.length ? i : null;
  }, [messages.length]);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    pointerInside.current = true;
    if (e.pointerType === 'touch' || !canHover) return;
    const i = indexAt(e.clientY);
    if (i !== hover) setHover(i);
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target instanceof Element ? e.target : null;
    const rowEl = target?.closest<HTMLElement>('[data-message-id]') ?? null;
    if (rowEl === null) return;
    const index = Number(rowEl.dataset['index']);
    const m = messages[index];
    if (m === undefined) return;
    const selecting = selected.size > 0;
    if (target?.closest('[data-select]') !== null || (selecting && (e.metaKey || e.ctrlKey || e.shiftKey))) onToggleSelect(m, index);
    else onOpen(m, index);
  };

  // Which row the action cluster belongs to: the one it was pinned to while it has focus; else the
  // row under the pointer; else the keyboard-cursor row while the list has focus.
  const hovered = hover === null ? undefined : messages[hover];
  const cursorRow = listFocused && keyboard ? messages[cursor] : undefined;
  const targetId = barFocused && pinned !== null ? pinned : (hovered?.id ?? cursorRow?.id ?? null);
  const targetIndex = targetId === null ? -1 : messages.findIndex((m) => m.id === targetId);
  const target = targetIndex < 0 ? undefined : messages[targetIndex];
  const rowTop = targetIndex * ROW_HEIGHT - scroll.top;
  const inView = rowTop > -ROW_HEIGHT / 2 && rowTop < scroll.height - ROW_HEIGHT / 2;
  const showActions = target !== undefined && !leaving.has(target.id) && selected.size === 0 && inView;

  const act = (action: RowAction) => {
    if (target === undefined) return;
    // The toolbar is about to lose its row: keep focus in the list, not on the page body.
    box.current?.focus({ preventScroll: true });
    setBarFocused(false);
    onRowAction(action, target, targetIndex);
  };

  const active = messages[cursor];
  const now = new Date();
  const selecting = selected.size > 0;
  return (
    <div
      className="pr-tlist"
      onPointerMove={onPointerMove}
      onPointerLeave={() => {
        pointerInside.current = false;
        setHover(null);
      }}
    >
      <div className="pr-tlist__pill" aria-live="polite">
        {pendingCount > 0 ? (
          <button type="button" className="pr-newpill" onClick={onShowNew}>
            <UpIcon />
            {pendingCount === 1 ? '1 new message' : `${String(pendingCount)} new messages`}
          </button>
        ) : null}
      </div>
      <div
        ref={box}
        className="pr-list pr-tlist__box"
        role="listbox"
        aria-label={label}
        aria-multiselectable={selecting ? true : undefined}
        tabIndex={0}
        {...(active === undefined ? {} : { 'aria-activedescendant': rowId(active.id) })}
        onScroll={(e) => {
          setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight });
        }}
        onFocus={(e) => {
          if (e.target !== e.currentTarget) return;
          setListFocused(true);
          setKeyboard(e.currentTarget.matches(':focus-visible'));
        }}
        onKeyDown={() => {
          setKeyboard(true);
        }}
        onPointerDown={() => {
          setKeyboard(false);
        }}
        onBlur={(e) => {
          if (e.target !== e.currentTarget) return;
          setListFocused(false);
          // Tab into the action cluster: pin it to the cursor row in the same update, or it would
          // unmount (no hover, no list focus) under the focus that is moving into it.
          const next = e.relatedTarget instanceof Element ? e.relatedTarget : null;
          const row = messages[cursor];
          if (next?.closest('.pr-rowacts') !== null && next !== null && row !== undefined) {
            setBarFocused(true);
            setPinned(hover === null ? row.id : (messages[hover]?.id ?? row.id));
          }
        }}
        onClick={onClick}
        style={{ paddingTop: start * ROW_HEIGHT, paddingBottom: (messages.length - end) * ROW_HEIGHT }}
      >
        {messages.slice(start, end).map((m, i) => {
          const index = start + i;
          return (
            <MessageRow
              key={m.id}
              message={m}
              index={index}
              count={messages.length}
              cursor={index === cursor}
              open={m.id === openId}
              checked={selecting ? selected.has(m.id) : undefined}
              leaving={leaving.has(m.id)}
              warned={m.id === warnedId}
              now={now}
            />
          );
        })}
      </div>
      {target === undefined ? null : (
        <RowActions
          subject={target.subject === null || target.subject === '' ? '(no subject)' : target.subject}
          top={Math.max(0, rowTop) + ACTIONS_INSET}
          visible={showActions || barFocused}
          canArchive={canArchive}
          canTrash={canTrash}
          canSnooze={canSnooze && target.threadId !== null}
          onArchive={() => {
            act('archive');
          }}
          onDelete={() => {
            act('delete');
          }}
          onSnooze={() => {
            act('snooze');
          }}
          onMove={() => {
            act('move');
          }}
          onFocusChange={(focused) => {
            setBarFocused(focused);
            if (focused) setPinned(target.id);
          }}
        />
      )}
    </div>
  );
});
