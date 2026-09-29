// The composer's marks (PST-T-14.7), drawn in currentColor like ../icons.tsx. Decorative only: every
// icon-only control carries its name in `label`.
import type { ReactNode } from 'react';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export const TrashIcon = () => (
  <Svg>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </Svg>
);

/** "Aa": the formatting bar's toggle. */
export const FormatIcon = () => (
  <Svg>
    <path d="M3 18 8 6l5 12M4.8 14h6.4" />
    <path d="M15 12.5a3 3 0 1 1 0 4 3 3 0 0 1 0-4zM20 11v7" />
  </Svg>
);

/** The header's Minimise: a bar. */
export const MinimiseIcon = () => (
  <Svg>
    <path d="M5 12h14" />
  </Svg>
);

/** The header's Restore, from minimised: a window. */
export const RestoreIcon = () => (
  <Svg>
    <rect x="4" y="5" width="16" height="14" rx="2" />
  </Svg>
);

/** Open full screen: arrows out to the corners. */
export const ExpandIcon = () => (
  <Svg>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </Svg>
);

/** Exit full screen: arrows in from the corners. */
export const CollapseIcon = () => (
  <Svg>
    <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
  </Svg>
);

export const CloseIcon = () => (
  <Svg>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

/** Insert link: two chain links. */
export const LinkIcon = () => (
  <Svg>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </Svg>
);

/** Beside "Draft saved". */
export const CheckIcon = () => (
  <Svg>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);
