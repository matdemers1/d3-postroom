import type { CSSProperties } from 'react';

/**
 * PST-T-17.17: letters fanning down into three trays, one of them landing in the tray marked with a
 * check. It is the thing Postroom does — mail sorting itself into folders — drawn in the theme's own
 * tokens, so it follows light and dark. Decorative, so hidden from assistive tech.
 *
 * Each piece is a positioned outer <g> (the SVG transform attribute) around an animated inner <g>:
 * a CSS transform on the same element would replace the attribute, not add to it.
 */
const TRAYS = [8, 108, 208] as const;
const TARGET = 2;

const LETTERS = [
  { x: 22, y: 44, r: -12 },
  { x: 115, y: 16, r: -2 },
  { x: 200, y: 38, r: 10 },
] as const;

function Letter({ landing = false }: { landing?: boolean }) {
  return (
    <>
      <rect width="70" height="46" rx="6" className={landing ? 'pr-entry-art__letter pr-entry-art__letter--landing' : 'pr-entry-art__letter'} />
      <path d="M6 6 35 27 64 6" className={landing ? 'pr-entry-art__flap pr-entry-art__flap--landing' : 'pr-entry-art__flap'} />
    </>
  );
}

function TrayBack({ x }: { x: number }) {
  return <path d={`M${String(x + 7)} 180h70l7 18H${String(x)}z`} className="pr-entry-art__tray-back" />;
}

function TrayFront({ x, target }: { x: number; target: boolean }) {
  return (
    <g>
      <rect x={x} y="198" width="84" height="48" rx="8" className={target ? 'pr-entry-art__tray pr-entry-art__tray--target' : 'pr-entry-art__tray'} />
      <rect x={x + 14} y="216" width={target ? 30 : 40} height="5" rx="2.5" className="pr-entry-art__label" />
      <rect x={x + 14} y="226" width={target ? 20 : 26} height="5" rx="2.5" className="pr-entry-art__label pr-entry-art__label--faint" />
      {target ? (
        <g transform={`translate(${String(x + 52)} 212)`}>
          <g className="pr-entry-art__tag">
            <rect width="20" height="20" rx="6" className="pr-entry-art__tag-fill" />
            <path d="m5.5 10.5 3 3 6-7" className="pr-entry-art__check" />
          </g>
        </g>
      ) : null}
    </g>
  );
}

export function SortingIllustration({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 300 256" fill="none" aria-hidden="true" focusable="false" className={className}>
      {/* The paths each letter takes: two to the plain trays, one down into the marked tray. */}
      <path d="M64 92c-6 28-12 56-14 80" className="pr-entry-art__trail" style={{ '--pr-entry-i': 0 } as CSSProperties} />
      <path d="M151 70c2 36 0 70-1 102" className="pr-entry-art__trail" style={{ '--pr-entry-i': 1 } as CSSProperties} />
      <path d="M229 98c10 16 16 34 18 54" className="pr-entry-art__trail" style={{ '--pr-entry-i': 2 } as CSSProperties} />

      {TRAYS.map((x) => (
        <TrayBack key={x} x={x} />
      ))}

      {LETTERS.map((l, i) => (
        <g key={l.x} transform={`translate(${String(l.x)} ${String(l.y)}) rotate(${String(l.r)})`}>
          <g className="pr-entry-art__fan" style={{ '--pr-entry-i': i } as CSSProperties}>
            <Letter />
          </g>
        </g>
      ))}

      {/* The one that lands: behind the marked tray's front, so it reads as dropped in. */}
      <g transform="translate(215 166) rotate(-4)">
        <g className="pr-entry-art__drop">
          <Letter landing />
        </g>
      </g>

      {TRAYS.map((x, i) => (
        <TrayFront key={x} x={x} target={i === TARGET} />
      ))}
    </svg>
  );
}
