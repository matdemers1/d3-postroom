// ⌘K / Ctrl+K (PST-T-9.3, PST-REQ-147): every keyboard action, "Move to <bucket>" for the message
// under the cursor, "Go to <mailbox>" and — PST-T-14.3 — every place in the route table, with
// keycaps from keys.ts. PST-T-15.5 (PST-REQ-194) rebuilt it on @d3cloud/ui's CommandPalette and made
// it search: typing asks GET /api/search (debounced, stale answers dropped) for a Messages group —
// avatar, subject with the match marked, "sender · date" — and filter chips (In, From, Has
// attachment, Date) narrow that ask to what the search API already honours (palette/search.ts).
// The library draws the dialog, the combobox/listbox, the arrow keys, Enter, Escape and focus return;
// it listens for no keys itself (D-078), so ⌘K stays with MailView and Shell, which own `open`.
import { createContext, useContext, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Avatar,
  CommandPalette as D3CommandPalette,
  CommandPaletteChip,
  CommandPaletteHint,
  type CommandPaletteGroup,
  type CommandPaletteItem,
} from '@d3cloud/ui';
import { api, type Mailbox, type MessageSummary } from '../api';
import { buildCommands, filterCommands, groupMatches, paletteShortcut, type Command, type CommandSection } from './commands';
import { mailboxIcon } from './icons';
import { mailboxLabel } from './format';
import type { MailAction } from './keys';
import { parseMailRoute, mailPath } from './route';
import { CalendarGlyph, PaperclipGlyph, PersonGlyph } from './palette/ChipIcons';
import { onPaletteOpenRequest } from './palette/open';
import {
  createSearchScheduler,
  currentMailbox,
  messageDescription,
  messageLabel,
  messagesLead,
  NO_FILTERS,
  requestKey,
  searchRequest,
  senderName,
  type PaletteFilters,
  type SearchOutcome,
} from './palette/search';

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

/** The dialog's and the input's accessible name (the library gives both the one name). */
export const PALETTE_LABEL = 'Command palette';
const MESSAGES_GROUP = 'Messages';

interface SearchState {
  key: string | null;
  outcome: SearchOutcome | null;
}
const NO_SEARCH: SearchState = { key: null, outcome: null };

function commandItem(command: Command, close: () => void): CommandPaletteItem {
  const shortcut = command.keycaps === undefined ? [] : paletteShortcut(command.keycaps);
  return {
    id: command.id,
    label: command.label,
    ...(command.hint === undefined ? {} : { description: command.hint }),
    ...(shortcut.length === 0 ? {} : { shortcut }),
    ...(command.mailbox === undefined ? {} : { leading: mailboxIcon(command.mailbox.specialUse, command.mailbox.name) }),
    // Closed before it runs, as before: a command that opens a dialog of its own (Move to…, Snooze…)
    // opens it after the palette has let go.
    onSelect: () => {
      close();
      command.run();
      return false;
    },
  };
}

export function CommandPalette({ open, onOpenChange, mailboxes, target, onAction, onMove, onNavigate, onSnooze, isAdmin: isAdminProp }: CommandPaletteProps) {
  const roleFromShell = useContext(PaletteRoleContext);
  const isAdmin = isAdminProp ?? roleFromShell;
  const location = useLocation();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<PaletteFilters>(NO_FILTERS);
  const [search, setSearch] = useState<SearchState>(NO_SEARCH);
  // Text handed over by openPalette(query) — the list's search field — for the next open.
  const [seed, setSeed] = useState<string | null>(null);

  // Every open starts clean (or with the handed-over text); derived during render, not in an
  // effect, so the first frame never shows the last visit's query.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery(seed ?? '');
      setFilters(NO_FILTERS);
      setSearch(NO_SEARCH);
    }
    setSeed(null);
  }

  useEffect(
    () =>
      onPaletteOpenRequest((text) => {
        setSeed(text ?? '');
        setQuery(text ?? '');
        onOpenChange(true);
      }),
    [onOpenChange],
  );

  const route = parseMailRoute(location.pathname, location.search);
  const here = route === null ? null : currentMailbox(mailboxes, route.mailboxId);
  const hereId = here?.id ?? null;
  const request = useMemo(() => (open ? searchRequest(query, filters, hereId) : null), [open, query, filters, hereId]);
  const key = requestKey(request);

  useEffect(() => {
    if (request === null) return undefined;
    const scheduler = createSearchScheduler(
      (r) => api.search(r.q, r.mailboxId === undefined ? {} : { mailboxId: r.mailboxId }),
      (settledKey, outcome) => {
        setSearch({ key: settledKey, outcome });
      },
    );
    scheduler.schedule(request);
    return () => {
      scheduler.cancel();
    };
  }, [request]);

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
  const sections = useMemo<CommandSection[]>(() => groupMatches(filterCommands(commands, query)), [commands, query]);

  const loading = key !== null && search.key !== key;
  // While the next answer is on its way the last one stays (the library shows a spinner over it).
  const outcome = key === null ? null : search.outcome;

  const groups = useMemo<CommandPaletteGroup[]>(() => {
    const close = (): void => {
      onOpenChange(false);
    };
    const commandGroups = sections.map<CommandPaletteGroup>((section) => ({
      id: section.group,
      label: section.group,
      items: section.matches.map((m) => commandItem(m.command, close)),
    }));
    if (outcome === null) return commandGroups;
    const now = new Date();
    const items: CommandPaletteItem[] = outcome.ok
      ? outcome.messages.map((m) => {
          const isDraft = mailboxes?.find((b) => b.id === m.mailboxId)?.specialUse === 'drafts';
          return {
            id: m.id,
            label: messageLabel(m),
            description: messageDescription(m, now),
            leading: <Avatar name={senderName(m)} size="sm" tint="auto" />,
            // Opened the way the list opens one: its mailbox, the message, a draft in the composer.
            onSelect: () => {
              close();
              onNavigate(mailPath(m.mailboxId, m.id, isDraft ? 'draft' : null));
              return false;
            },
          };
        })
      : [{ id: 'search-unavailable', label: 'Message search is unavailable right now', disabled: true, onSelect: () => false }];
    const messages: CommandPaletteGroup = { id: MESSAGES_GROUP, label: MESSAGES_GROUP, items };
    const top = sections[0]?.matches[0]?.command.label ?? null;
    if (messagesLead(top, query)) return [messages, ...commandGroups];
    return [...commandGroups.slice(0, 1), messages, ...commandGroups.slice(1)];
  }, [sections, outcome, mailboxes, onNavigate, onOpenChange, query]);

  const toggle = (name: keyof PaletteFilters): void => {
    setFilters((f) => ({ ...f, [name]: !f[name] }));
  };
  // A pointer on a chip leaves focus in the input, so typing and the arrow keys carry on.
  const keepFocus = (e: MouseEvent): void => {
    e.preventDefault();
  };

  return (
    <D3CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      label={PALETTE_LABEL}
      placeholder="Search mail, mailboxes and actions…"
      loading={loading}
      filters={
        <>
          {here === null ? null : (
            <CommandPaletteChip
              pressed={filters.inMailbox}
              onMouseDown={keepFocus}
              onClick={() => {
                toggle('inMailbox');
              }}
            >
              In: <b>{mailboxLabel(here)}</b>
            </CommandPaletteChip>
          )}
          <CommandPaletteChip
            pressed={filters.from}
            onMouseDown={keepFocus}
            onClick={() => {
              toggle('from');
            }}
          >
            <PersonGlyph />
            From
          </CommandPaletteChip>
          <CommandPaletteChip
            pressed={filters.hasAttachment}
            onMouseDown={keepFocus}
            onClick={() => {
              toggle('hasAttachment');
            }}
          >
            <PaperclipGlyph />
            Has attachment
          </CommandPaletteChip>
          <CommandPaletteChip
            pressed={filters.recent}
            onMouseDown={keepFocus}
            onClick={() => {
              toggle('recent');
            }}
          >
            <CalendarGlyph />
            Date: last 7 days
          </CommandPaletteChip>
        </>
      }
      footer={
        <>
          <CommandPaletteHint keys={['↑', '↓']}>navigate</CommandPaletteHint>
          <CommandPaletteHint keys={['↵']}>open</CommandPaletteHint>
          <CommandPaletteHint keys={['esc']}>close</CommandPaletteHint>
        </>
      }
    />
  );
}
