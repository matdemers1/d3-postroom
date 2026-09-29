// ⌘K / Ctrl+K (PST-T-9.3, PST-REQ-147): every keyboard action, "Move to <bucket>" for the message
// under the cursor, "Go to <mailbox>" and — PST-T-14.3 — every place in the route table, in one
// filterable list grouped as Message actions, Go to, Settings and Admin, with keycaps from keys.ts.
// Modal already gives it role="dialog"/aria-modal, a focus trap and focus return (it wraps Radix's
// Dialog); this component layers the combobox/listbox pattern on top — an input owning
// aria-activedescendant, and a listbox of options it points at — so arrow keys move the selection
// without moving DOM focus off the input, the way the message list's j/k cursor already works.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Input, Modal, Stack } from '@d3cloud/ui';
import '../styles/places.css';
import type { Mailbox, MessageSummary } from '../api';
import { buildCommands, filterCommands, groupMatches, type Command, type CommandMatch } from './commands';
import type { MailAction } from './keys';

/** Whether the signed-in account is an admin — provided by Shell, so the palette MailView mounts
 * filters Admin entries without MailView having to pass the role through. */
export const PaletteRoleContext = createContext<boolean>(false);

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mailboxes: readonly Mailbox[] | null;
  target: MessageSummary | null;
  /** Absent outside Mail: no keyboard-action commands. */
  onAction?: (action: MailAction) => void;
  onMove: (message: MessageSummary, mailbox: Mailbox) => void;
  onNavigate: (path: string) => void;
  /** PST-T-9.1: snooze the target's conversation. Absent: no snooze commands. */
  onSnooze?: (message: MessageSummary, until: Date) => void;
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

function Keycaps({ keys }: { keys: readonly string[] }) {
  return (
    <span className="pr-cmdk__keys" aria-hidden="true">
      {keys.map((k, i) => (k === 'then' || k === 'or' ? <span key={i} className="pr-cmdk__then">{k}</span> : <kbd key={i}>{k}</kbd>))}
    </span>
  );
}

export function CommandPalette({ open, onOpenChange, mailboxes, target, onAction, onMove, onNavigate, onSnooze, isAdmin: isAdminProp }: CommandPaletteProps) {
  const roleFromShell = useContext(PaletteRoleContext);
  const isAdmin = isAdminProp ?? roleFromShell;
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
    () =>
      buildCommands(
        {
          mailboxes,
          target,
          move: onMove,
          navigate: onNavigate,
          ...(onAction === undefined ? {} : { perform: onAction }),
          ...(onSnooze === undefined ? {} : { snooze: onSnooze }),
        },
        isAdmin,
      ),
    [mailboxes, target, onAction, onMove, onNavigate, onSnooze, isAdmin],
  );
  // Rows are shown under their group headers; arrow keys walk them in that display order.
  const sections = useMemo(() => groupMatches(filterCommands(commands, query)), [commands, query]);
  const matches = useMemo<CommandMatch[]>(() => sections.flatMap((s) => s.matches), [sections]);

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
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      className="pr-cmdk"
      title="Command palette"
      description="Every action, bucket move and place in Postroom, searched by name."
    >
      <Stack gap="8">
        <Input
          appearance="filled"
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="pr-cmdk-list"
          aria-autocomplete="list"
          {...(activeId === undefined ? {} : { 'aria-activedescendant': activeId })}
          aria-label="Type a command"
          placeholder="Search commands, places and settings…"
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
        <div id="pr-cmdk-list" role="listbox" aria-label="Commands" className="pr-cmdk__list">
          {sections.map((section) => (
            <div key={section.group} role="group" aria-labelledby={`pr-cmdk-g-${optionId(section.group)}`} className="pr-cmdk__group">
              <div id={`pr-cmdk-g-${optionId(section.group)}`} className="pr-cmdk__heading" role="presentation" aria-hidden="true">
                {section.group}
              </div>
              {section.matches.map((m) => {
                const index = matches.indexOf(m);
                return (
                  <div
                    key={m.command.id}
                    id={optionId(m.command.id)}
                    role="option"
                    aria-selected={index === active}
                    className="pr-cmdk__row"
                    onMouseEnter={() => {
                      setActive(index);
                    }}
                    onClick={() => {
                      run(m);
                    }}
                  >
                    <span className="pr-cmdk__label">{highlighted(m.command.label, m.indices)}</span>
                    {m.command.hint === undefined ? null : <span className="pr-cmdk__hint">{m.command.hint}</span>}
                    {m.command.keycaps === undefined ? null : <Keycaps keys={m.command.keycaps} />}
                  </div>
                );
              })}
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
