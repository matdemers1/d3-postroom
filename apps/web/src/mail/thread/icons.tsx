// The thread toolbar's marks (PST-T-14.6), drawn in currentColor like ../icons.tsx. Decorative only:
// every icon-only control carries its name in `label` and a tooltip.
import type { ReactNode } from 'react';

function Svg({ children, fill = 'none' }: { children: ReactNode; fill?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill={fill} stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export const ReplyIcon = () => (
  <Svg>
    <path d="M9 7 4 12l5 5" />
    <path d="M4 12h10a6 6 0 0 1 6 6v1" />
  </Svg>
);

export const ReplyAllIcon = () => (
  <Svg>
    <path d="M8 7 3 12l5 5" />
    <path d="M12 7l-5 5 5 5" />
    <path d="M7 12h8a6 6 0 0 1 6 6v1" />
  </Svg>
);

export const ForwardIcon = () => (
  <Svg>
    <path d="m15 7 5 5-5 5" />
    <path d="M20 12H10a6 6 0 0 0-6 6v1" />
  </Svg>
);

export const ClockIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4l3 2" />
  </Svg>
);

export const MoreIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="currentColor">
    <circle cx="5" cy="12" r="1.75" />
    <circle cx="12" cy="12" r="1.75" />
    <circle cx="19" cy="12" r="1.75" />
  </svg>
);

export const CaretIcon = () => (
  <Svg>
    <path d="m7 10 5 5 5-5" />
  </Svg>
);

// PST-T-15.3: the canvas toolbar's triage marks, the list position arrows, the header's star, and
// an attachment's download mark.

export const ArchiveIcon = () => (
  <Svg>
    <rect x="2" y="3" width="20" height="5" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </Svg>
);

export const TrashIcon = () => (
  <Svg>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </Svg>
);

export const MoveIcon = () => (
  <Svg>
    <path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1" />
    <path d="M2 13h10" />
    <path d="m9 16 3-3-3-3" />
  </Svg>
);

export const ChevronUpIcon = () => (
  <Svg>
    <path d="m18 15-6-6-6 6" />
  </Svg>
);

export const ChevronDownIcon = () => (
  <Svg>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

/** Outlined, or filled when the message is starred — the shape changes, not only a colour. */
export const StarIcon = ({ filled = false }: { filled?: boolean }) => (
  <Svg fill={filled ? 'currentColor' : 'none'}>
    <path d="M11.5 2.6a.5.5 0 0 1 .9 0l2.3 4.7a2 2 0 0 0 1.5 1.1l5.2.8a.5.5 0 0 1 .3.9l-3.8 3.7a2 2 0 0 0-.6 1.8l.9 5.2a.5.5 0 0 1-.7.5l-4.6-2.4a2 2 0 0 0-1.9 0l-4.6 2.4a.5.5 0 0 1-.7-.5l.9-5.2a2 2 0 0 0-.6-1.8L1.8 10.1a.5.5 0 0 1 .3-.9l5.2-.8a2 2 0 0 0 1.5-1.1z" />
  </Svg>
);

export const DownloadIcon = () => (
  <Svg>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </Svg>
);
