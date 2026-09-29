// The thread toolbar's marks (PST-T-14.6), drawn in currentColor like ../icons.tsx. Decorative only:
// every icon-only control carries its name in `label` and a tooltip.
import type { ReactNode } from 'react';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
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
