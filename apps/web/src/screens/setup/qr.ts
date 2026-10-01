// A QR code as SVG path data, computed in the browser from the otpauth URI (PST-REQ-196). Nothing
// is fetched and no image URL is made: the matrix from qrcode-generator becomes one <path>, so the
// page's CSP (img-src 'self' data:) is untouched and the secret never leaves the page.
import qrcode from 'qrcode-generator';

/** The quiet zone the QR specification asks for: four modules of light on every side. */
export const QUIET_ZONE = 4;

export interface QrShape {
  /** Width and height in modules, quiet zone included — the SVG's viewBox. */
  size: number;
  /** One path with a unit square for every dark module, offset by the quiet zone. */
  path: string;
}

export function qrShape(text: string): QrShape {
  // Type 0 picks the smallest version that fits; M recovers ~15%, ample for a screen.
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (code.isDark(row, col)) parts.push(`M${String(col + QUIET_ZONE)} ${String(row + QUIET_ZONE)}h1v1h-1z`);
    }
  }
  return { size: count + 2 * QUIET_ZONE, path: parts.join('') };
}
