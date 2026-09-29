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
