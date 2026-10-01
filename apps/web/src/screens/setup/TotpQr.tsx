import { useMemo } from 'react';
import { qrShape } from './qr';

/**
 * The otpauth URI as a QR code (PST-REQ-196), drawn as inline SVG. A QR must be dark on light to
 * scan, so it sits in a light-theme island (`data-theme="light"`, which @d3cloud/ui's tokens are
 * scoped to) and keeps that in the dark theme too: --color-fg modules on --color-surface-raised.
 */
export function TotpQr({ uri }: { uri: string }) {
  const { size, path } = useMemo(() => qrShape(uri), [uri]);
  return (
    <div className="pr-totp-qr" data-theme="light">
      <svg
        role="img"
        aria-label="QR code for your authenticator app"
        data-testid="totp-qr"
        viewBox={`0 0 ${String(size)} ${String(size)}`}
        shapeRendering="crispEdges"
      >
        <rect className="pr-totp-qr__light" width={size} height={size} />
        <path className="pr-totp-qr__dark" d={path} />
      </svg>
    </div>
  );
}
