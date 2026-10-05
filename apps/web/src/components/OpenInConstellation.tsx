// "Open in D3 Constellation" (PST-T-20.1): the open message in the native app, by a
// `d3constellation://<host>/postroom/message/<id>` link. The host names this server, so the app picks
// the matching connection and the link never crosses servers; the app routes postroom/message/<id>,
// postroom/priority and postroom/compose.
//
// Offered only on Apple devices — the only place the app exists. iPadOS Safari calls itself a Mac.
import { Button } from '@d3cloud/ui';
import { SmartphoneIcon } from '../mail/icons';

export const CONSTELLATION_LABEL = 'Open in D3 Constellation';

/** The app's link for a Postroom path ("message/<id>", "priority", "compose") on this server. */
export function constellationLink(path: string, host: string = window.location.host): string {
  return `d3constellation://${host}/postroom/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** The link that opens one message (or its thread) in the app. */
export const messageLink = (messageId: string, host?: string): string => constellationLink(`message/${messageId}`, host);

/** iPhone, iPad or Mac: the devices D3 Constellation runs on. */
export function onApple(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /iPhone|iPad|Macintosh/.test(userAgent);
}

/** Opens `messageId` in the app. */
export function openInConstellation(messageId: string): void {
  window.location.href = messageLink(messageId);
}

/** The toolbar's button: nothing at all off Apple devices. */
export function OpenInConstellation({ messageId, userAgent }: { messageId: string; userAgent?: string }) {
  if (!onApple(userAgent)) return null;
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      icon={<SmartphoneIcon />}
      onClick={() => {
        openInConstellation(messageId);
      }}
    >
      {CONSTELLATION_LABEL}
    </Button>
  );
}
