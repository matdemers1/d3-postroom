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
    case 'rejects':
      return <JunkIcon />;
    case 'trash':
      return <TrashIcon />;
    default:
      return <FolderIcon />;
  }
}
