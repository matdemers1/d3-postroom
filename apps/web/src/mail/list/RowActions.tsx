// PST-T-14.5: Archive · Delete · Snooze · Move for one row, drawn over the row's date. It shows for
// the row under the pointer, for the keyboard-cursor row while the list (or this toolbar) has focus,
// and while it has focus itself — never hover-only. It is a SIBLING of the listbox, not inside a
// row, so no option contains a button; Tab from the list lands on it, and the arrow keys move
// between its buttons (one tab stop, roving tabindex, the ARIA toolbar pattern).
import { useRef, useState, type KeyboardEvent } from 'react';
import { IconButton } from '@d3cloud/ui';
import { ArchiveIcon, FolderIcon, TrashIcon } from '../icons';
import { ClockIcon } from './glyphs';

export interface RowActionsProps {
  subject: string;
  /** Offset from the top of the list's viewport, in px. */
  top: number;
  visible: boolean;
  canArchive: boolean;
  canTrash: boolean;
  canSnooze: boolean;
  onArchive: () => void;
  onDelete: () => void;
  onSnooze: () => void;
  onMove: () => void;
  onFocusChange: (focused: boolean) => void;
}

export function RowActions({ subject, top, visible, canArchive, canTrash, canSnooze, onArchive, onDelete, onSnooze, onMove, onFocusChange }: RowActionsProps) {
  const [active, setActive] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  const actions = [
    canArchive ? { key: 'archive', label: 'Archive', shortcut: 'e', icon: <ArchiveIcon />, run: onArchive } : null,
    canTrash ? { key: 'delete', label: 'Delete', shortcut: '#', icon: <TrashIcon />, run: onDelete } : null,
    canSnooze ? { key: 'snooze', label: 'Snooze', shortcut: 'b', icon: <ClockIcon />, run: onSnooze } : null,
    { key: 'move', label: 'Move', shortcut: 'v', icon: <FolderIcon />, run: onMove },
  ].filter((a) => a !== null);
  const current = Math.min(active, actions.length - 1);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const edge = e.key === 'Home' ? 0 : e.key === 'End' ? actions.length - 1 : null;
    if (delta === 0 && edge === null) return;
    e.preventDefault();
    const next = edge ?? (current + delta + actions.length) % actions.length;
    setActive(next);
    bar.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };

  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={`Actions for ${subject}`}
      className="pr-rowacts"
      data-visible={visible ? 'true' : 'false'}
      style={{ top }}
      onKeyDown={onKeyDown}
      onFocus={() => {
        onFocusChange(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onFocusChange(false);
      }}
    >
      {actions.map((a, i) => (
        <IconButton
          key={a.key}
          size="sm"
          variant="ghost"
          icon={a.icon}
          label={a.label}
          aria-keyshortcuts={a.shortcut}
          tabIndex={i === current ? 0 : -1}
          onClick={() => {
            setActive(i);
            a.run();
          }}
        />
      ))}
    </div>
  );
}
