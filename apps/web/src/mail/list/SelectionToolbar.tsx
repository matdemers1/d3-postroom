// PST-T-14.5: once x (or a click on an avatar) selects a row, this replaces the list's header in
// the same box — laid over it, the header kept underneath and made inert — so nothing below moves.
// Archive / Delete / Snooze / Move act on the selected messages; Esc or Clear leaves selection.
import { Button } from '@d3cloud/ui';
import { ArchiveIcon, FolderIcon, TrashIcon } from '../icons';
import { ClockIcon } from './glyphs';

export interface SelectionToolbarProps {
  count: number;
  total: number;
  canArchive: boolean;
  canTrash: boolean;
  canSnooze: boolean;
  onArchive: () => void;
  onDelete: () => void;
  onSnooze: () => void;
  onMove: () => void;
  onSelectAll: () => void;
  onClear: () => void;
}

const Key = ({ k }: { k: string }) => (
  <kbd className="pr-seltool__key" aria-hidden="true">
    {k}
  </kbd>
);

export function SelectionToolbar({ count, total, canArchive, canTrash, canSnooze, onArchive, onDelete, onSnooze, onMove, onSelectAll, onClear }: SelectionToolbarProps) {
  return (
    <div className="pr-seltool" role="toolbar" aria-label="Selected messages">
      <div className="pr-seltool__top">
        <span className="pr-seltool__count" aria-live="polite">
          {count === 1 ? '1 selected' : `${String(count)} selected`}
        </span>
        {count < total ? (
          <Button size="sm" variant="ghost" onClick={onSelectAll}>
            Select all {total}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" className="pr-seltool__clear" aria-keyshortcuts="Escape" onClick={onClear}>
          Clear <Key k="Esc" />
        </Button>
      </div>
      <div className="pr-seltool__actions">
        {canArchive ? (
          <Button size="sm" variant="secondary" icon={<ArchiveIcon />} aria-keyshortcuts="e" onClick={onArchive}>
            Archive <Key k="e" />
          </Button>
        ) : null}
        {canTrash ? (
          <Button size="sm" variant="secondary" icon={<TrashIcon />} aria-keyshortcuts="#" onClick={onDelete}>
            Delete <Key k="#" />
          </Button>
        ) : null}
        {canSnooze ? (
          <Button size="sm" variant="secondary" icon={<ClockIcon />} aria-keyshortcuts="b" onClick={onSnooze}>
            Snooze <Key k="b" />
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" icon={<FolderIcon />} aria-keyshortcuts="v" onClick={onMove}>
          Move <Key k="v" />
        </Button>
      </div>
    </div>
  );
}
