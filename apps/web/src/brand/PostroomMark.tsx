// PST-T-16.10 (PST-DA-055): the Postroom mark. A postroom is where mail is sorted, so the mark is a
// sorting rack: four pigeonholes, one of them filled with the accent and holding a folded letter.
// Drawn on D3 tokens (--color-fg for the empty holes, --color-accent for the filled one) so it
// follows both themes. public/favicon.svg is the same drawing with fixed colours.

export const POSTROOM_MARK_NAME = 'Postroom';

export interface PostroomMarkProps {
  /** Rendered width and height in px. */
  size?: number;
  /**
   * Set when the word "Postroom" is written beside the mark, so a screen reader does not read it
   * twice. Left off, the mark stands alone and is announced as an image named "Postroom".
   */
  decorative?: boolean;
}

export function PostroomMark({ size = 20, decorative = false }: PostroomMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': POSTROOM_MARK_NAME })}
    >
      <g style={{ stroke: 'var(--color-fg)' }} strokeWidth="1.75">
        <rect x="2.9" y="2.9" width="8.2" height="8.2" rx="2.2" />
        <rect x="2.9" y="12.9" width="8.2" height="8.2" rx="2.2" />
        <rect x="12.9" y="12.9" width="8.2" height="8.2" rx="2.2" />
      </g>
      <rect x="12" y="2" width="10" height="10" rx="2.8" style={{ fill: 'var(--color-accent)' }} />
      <path
        d="m14.6 5.8 2.4 2 2.4-2M14.6 5.8h4.8v3.6h-4.8z"
        style={{ stroke: 'var(--color-accent-contrast)' }}
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
