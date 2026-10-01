// Decorative marks for the mail view, drawn in currentColor so they follow the theme. No icon
// library: @d3cloud/ui ships none, and nothing third-party loads (PST-REQ-159).
import type { ReactNode } from 'react';
import type { SpecialUse } from '../api';

function Svg({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export const InboxIcon = () => (
  <Svg>
    <path d="M3 13h5l1.5 3h5L16 13h5" />
    <path d="M5 5h14l2 8v6H3v-6z" />
  </Svg>
);
export const SentIcon = () => (
  <Svg>
    <path d="m4 12 16-8-6 16-2-6z" />
  </Svg>
);
export const DraftIcon = () => (
  <Svg>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
  </Svg>
);
export const ArchiveIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v10h14V9M10 13h4" />
  </Svg>
);
export const JunkIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="8" />
    <path d="m6.5 6.5 11 11" />
  </Svg>
);
// PST-T-16.3 (PST-DA-018): each sorted bucket and Rejects has a mark of its own, so the sidebar,
// palette and triage picker tell them apart at a glance without leaning on the label.
/** Rejects: a shield with a cross — mail the server refused, as against Junk's ban sign. */
export const RejectsIcon = () => (
  <Svg>
    <path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z" />
    <path d="m9.5 9.5 5 5M14.5 9.5l-5 5" />
  </Svg>
);
/** Updates: two arrows chasing each other — something changed. */
export const UpdatesIcon = () => (
  <Svg>
    <path d="M20 12a8 8 0 0 0-13.7-5.6L4 8.5" />
    <path d="M4 4v4.5h4.5" />
    <path d="M4 12a8 8 0 0 0 13.7 5.6l2.3-2.1" />
    <path d="M20 20v-4.5h-4.5" />
  </Svg>
);
/** Receipts: a till roll with a torn edge and line items. */
export const ReceiptsIcon = () => (
  <Svg>
    <path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21z" />
    <path d="M9 8h6M9 12h6" />
  </Svg>
);
/** Notifications: a bell. */
export const NotificationsIcon = () => (
  <Svg>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </Svg>
);
/** Newsletters: a folded newspaper with a masthead and columns. */
export const NewslettersIcon = () => (
  <Svg>
    <path d="M7 4h13v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8h4" />
    <path d="M10.5 8h6M10.5 12h6M10.5 15.5h3" />
    <path d="M7 4v14a2 2 0 0 1-2 2" />
  </Svg>
);
export const TrashIcon = () => (
  <Svg>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </Svg>
);
export const FolderIcon = () => (
  <Svg>
    <path d="M3 6h6l2 2h10v11H3z" />
  </Svg>
);
export const ComposeIcon = () => (
  <Svg size={16}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const StarIcon = ({ filled = false }: { filled?: boolean }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round">
    <path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4l-5.5 2.9 1-6.2L3 9.7l6.2-.9z" />
  </svg>
);
export const PaperclipIcon = () => (
  <Svg size={16}>
    <path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7" />
  </Svg>
);

export function mailboxIcon(use: SpecialUse | null, name: string): ReactNode {
  if (name.toUpperCase() === 'INBOX' || use === 'inbox') return <InboxIcon />;
  switch (use) {
    case 'sent':
      return <SentIcon />;
    case 'drafts':
      return <DraftIcon />;
    case 'archive':
      return <ArchiveIcon />;
    case 'junk':
      return <JunkIcon />;
    case 'rejects':
      return <RejectsIcon />;
    case 'trash':
      return <TrashIcon />;
    default:
      // The sorter's bucket folders carry no special-use flag; they are known by name.
      switch (name.toLowerCase()) {
        case 'updates':
          return <UpdatesIcon />;
        case 'receipts':
          return <ReceiptsIcon />;
        case 'notifications':
          return <NotificationsIcon />;
        case 'newsletters':
          return <NewslettersIcon />;
        default:
          return <FolderIcon />;
      }
  }
}

// PST-T-11.4: the search field's glyph, and alert icons so a warning's tone never rests on colour alone.
export const SearchIcon = () => (
  <Svg size={16}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Svg>
);
export const DangerIcon = () => (
  <Svg size={18}>
    <path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z" />
    <path d="M12 8v5M12 16.5v.01" />
  </Svg>
);
export const WarningIcon = () => (
  <Svg size={18}>
    <path d="M12 3.5 21.5 20h-19z" />
    <path d="M12 10v4.5M12 17.5v.01" />
  </Svg>
);
export const InfoIcon = () => (
  <Svg size={18}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.5v.01" />
  </Svg>
);
export const ChevronIcon = () => (
  <Svg size={16}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);
