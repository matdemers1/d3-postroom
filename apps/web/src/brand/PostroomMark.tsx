// PST-T-18.1: the Postroom mark is the D3 Cloud family mark (DI-REQ-040), concept "Envelope", ported
// from d3cloud.io's ProductMark. It replaces the sorting rack of PST-T-16.10 (PST-DA-055) — four
// pigeonholes with one filled in the accent — so Postroom reads as one of the family beside Bindery,
// D3 Auth, Foreman and Shipyard: every product keeps the planisphere's ring, and inside it ink lines
// with round joints and exactly one lit star in the product's own colour. Here an envelope sits in
// the ring, joints where the flap meets the body, and the lit star where the flap points.
//
// The ink is currentColor, so the mark takes the text colour in either theme — a call site inside a
// slot that paints the accent (AppShellBrand's mark slot does) sets the text colour back with a class.
// The star is the only colour. public/favicon.svg is the same drawing at icon weight, with the ink
// fixed per scheme.

export const POSTROOM_MARK_NAME = 'Postroom';

// d3-allow: the product's lit star from d3cloud.io (DI-REQ-040) — a brand constant, the same in both themes, not a theme colour
export const POSTROOM_STAR = '#E06AB8';

export interface PostroomMarkProps {
  /** Rendered width and height in px. At 72 and above the lines are drawn finer, as on the site. */
  size?: number;
  /**
   * Set when the word "Postroom" is written beside the mark, so a screen reader does not read it
   * twice. Left off, the mark stands alone and is announced as an image named "Postroom".
   */
  decorative?: boolean;
  className?: string;
}

export function PostroomMark({ size = 20, decorative = false, className }: PostroomMarkProps) {
  // The site's two weights: heavier at icon sizes, finer at display sizes.
  const display = size >= 72;
  const w = display ? 2.2 : 3.5;
  const joint = display ? 2.6 : 3.4;
  const lit = display ? 4.4 : 5.5;
  const ink = { stroke: 'currentColor', strokeWidth: w, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': POSTROOM_MARK_NAME })}
    >
      <circle cx="32" cy="32" r="26" {...ink} />
      <path d="M17 22 H47 V44 H17 Z" {...ink} />
      <path d="M17 22 L32 34.5 L47 22" {...ink} />
      <circle cx="17" cy="22" r={joint} fill="currentColor" />
      <circle cx="47" cy="22" r={joint} fill="currentColor" />
      <circle cx="32" cy="34.5" r={lit} style={{ fill: POSTROOM_STAR }} />
    </svg>
  );
}
