// ⌘K / Ctrl+K (PST-T-9.3, PST-REQ-147): every keyboard action, "Move to <bucket>" for the message
// under the cursor, "Go to <mailbox>" and the account/admin screens, all in one filterable list.
// Modal already gives it role="dialog"/aria-modal, a focus trap and focus return (it wraps Radix's
// Dialog); this component layers the combobox/listbox pattern on top — an input owning
// aria-activedescendant, and a listbox of options it points at — so arrow keys move the selection
// without moving DOM focus off the input, the way MessageList's j/k cursor already works.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Input, Modal, Stack } from '@d3cloud/ui';
import type { Mailbox, MessageSummary } from '../api';
import { buildCommands, filterCommands, type Command, type CommandMatch } from './commands';
import type { MailAction } from './keys';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mailboxes: readonly Mailbox[] | null;
  target: MessageSummary | null;
  onAction: (action: MailAction) => void;
  onMove: (message: MessageSummary, mailbox: Mailbox) => void;
  onNavigate: (path: string) => void;
  isAdmin?: boolean;
}

const optionId = (id: string): string => `pr-cmd-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

function highlighted(label: string, indices: readonly number[]): ReactNode {
  if (indices.length === 0) return label;
  const marks = new Set(indices);
  return label
    .split('')
    .map((ch, i) => (marks.has(i) ? <mark key={i}>{ch}</mark> : <span key={i}>{ch}</span>));
}

export function CommandPalette({ open, onOpenChange, mailboxes, target, onAction, onMove, onNavigate, isAdmin = true }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(id);
    };
  }, [open]);

  const commands = useMemo<Command[]>(
    () => buildCommands({ mailboxes, target, perform: onAction, move: onMove, navigate: onNavigate }, isAdmin),
    [mailboxes, target, onAction, onMove, onNavigate, isAdmin],
  );
  const matches = useMemo<CommandMatch[]>(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    setActive((a) => (matches.length === 0 ? 0 : Math.min(a, matches.length - 1)));
  }, [matches.length]);

  const run = (match: CommandMatch | undefined) => {
    if (match === undefined) return;
    onOpenChange(false);
    match.command.run();
  };

  const activeMatch = matches[active];
  const activeId = activeMatch === undefined ? undefined : optionId(activeMatch.command.id);

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="lg" title="Command palette" description="Every action and bucket move, searched by name.">
      <Stack gap="8">
        <Input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="pr-cmdk-list"
          aria-autocomplete="list"
          {...(activeId === undefined ? {} : { 'aria-activedescendant': activeId })}
          aria-label="Type a command"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => (matches.length === 0 ? 0 : (a + 1) % matches.length));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => (matches.length === 0 ? 0 : (a - 1 + matches.length) % matches.length));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(matches[active]);
            }
          }}
        />
        <div id="pr-cmdk-list" role="listbox" aria-label="Commands" className="pr-list">
          {matches.map((m, index) => (
            <div
              key={m.command.id}
              id={optionId(m.command.id)}
              role="option"
              aria-selected={index === active}
              className="pr-row"
              onMouseEnter={() => {
                setActive(index);
              }}
              onClick={() => {
                run(m);
              }}
            >
              <span className="pr-row__from">{highlighted(m.command.label, m.indices)}</span>
              <span className="pr-row__date">{m.command.group}</span>
            </div>
          ))}
        </div>
        {matches.length === 0 ? (
          <p className="pr-notice" role="status">
            Nothing matches “{query}”.
          </p>
        ) : null}
      </Stack>
    </Modal>
  );
}
