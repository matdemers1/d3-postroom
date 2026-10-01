import { useMemo } from 'react';
import { qrShape } from '../setup/qr';
import '../setup/totp.css';

/**
 * The one-time profile URL as a QR code, drawn as inline SVG in the browser (nothing fetched, no
 * image URL). The same light island as the TOTP code on Setup, so it scans in the dark theme too.
 */
export function DeviceQr({ url }: { url: string }) {
  const { size, path } = useMemo(() => qrShape(url), [url]);
  return (
    <div className="pr-totp-qr" data-theme="light">
      <svg role="img" aria-label="QR code that opens the profile on your iPhone" data-testid="device-qr" viewBox={`0 0 ${String(size)} ${String(size)}`} shapeRendering="crispEdges">
        <rect className="pr-totp-qr__light" width={size} height={size} />
        <path className="pr-totp-qr__dark" d={path} />
      </svg>
    </div>
  );
}
