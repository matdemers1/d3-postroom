// PST-T-14.8 (PST-REQ-155, PST-REQ-192, PST-REQ-193, PST-ADR-011): at phone width (≤767 px) the
// whole app is ONE push stack — Mailboxes → list → thread, and Mailboxes → Settings → a settings
// screen → the Admin console → an admin screen. Each screen has a depth; a move to a deeper screen
// slides in from the right, a move to a shallower one reverses it. Pure and DOM-free, so it is
// unit-tested (test/unit/mobile-push.test.ts).
import { narrowView, parseMailRoute } from '../mail/route';
import { PLACE_NAME, routeForPath, type RouteId } from '../routes';

/** Phone width: below the split layout's 768 px (useMedia.ts's SPLIT_QUERY). */
export const PHONE_MAX = 767;

/** Settings' and the Admin console's first push level on a phone: a list of the place's screens. */
export type PlaceIndex = 'settings' | 'admin';

/** '/settings' and '/admin' are that place's index on a phone (on a wider screen they redirect). */
export function placeIndexFor(pathname: string): PlaceIndex | null {
  const p = pathname.replace(/\/+$/, '');
  if (p === '/settings') return 'settings';
  if (p === '/admin') return 'admin';
  return null;
}

/** How deep a screen sits in the phone's push stack. Unknown paths are the root. */
export function pushDepth(pathname: string, search = ''): number {
  const index = placeIndexFor(pathname);
  if (index === 'settings') return 1;
  if (index === 'admin') return 2;
  const mail = parseMailRoute(pathname, search);
  const route = routeForPath(pathname);
  if (mail !== null && (route?.id === 'mail' || route?.id === 'mailFolder')) {
    const view = narrowView(mail);
    if (view === 'mailboxes') return 0;
    if (view === 'list') return 1;
    if (view === 'message') return 2;
    return mail.messageId === null ? 2 : 3;
  }
  if (route === null) return 0;
  const deeper: Partial<Record<RouteId, number>> = { calendar: 1, contacts: 1, contactNew: 2, contactCard: 2, sender: 3 };
  const known = deeper[route.id];
  if (known !== undefined) return known;
  if (route.place === 'settings') return 2;
  if (route.place === 'admin') return 3;
  return 1;
}

export type PushDirection = 'forward' | 'back' | 'none';

/** Deeper slides in from the right; shallower reverses; the same depth simply swaps. */
export function pushDirection(from: number | null, to: number): PushDirection {
  if (from === null || from === to) return 'none';
  return to > from ? 'forward' : 'back';
}

export interface ContextParent {
  /** Where Back goes. */
  to: string;
  /** Back's words: the parent's name. */
  label: string;
}

/**
 * The screen a non-mail screen's Back returns to, on a phone. `lastMail` is the last mail URL this
 * tab showed and `lastMailName` its mailbox's name (the sender profile returns there).
 */
export function contextParent(pathname: string, lastMail: string, lastMailName: string): ContextParent | null {
  const index = placeIndexFor(pathname);
  if (index === 'settings') return { to: '/mail', label: 'Mailboxes' };
  if (index === 'admin') return { to: '/settings', label: PLACE_NAME.settings };
  const route = routeForPath(pathname);
  if (route === null || route.id === 'mail' || route.id === 'mailFolder') return null;
  if (route.id === 'sender') return { to: lastMail, label: lastMailName };
  if (route.id === 'contactNew' || route.id === 'contactCard') return { to: '/contacts', label: 'Contacts' };
  if (route.place === 'settings') return { to: '/settings', label: PLACE_NAME.settings };
  if (route.place === 'admin') return { to: '/admin', label: 'Admin' };
  return { to: '/mail', label: 'Mailboxes' };
}

/** The title a non-mail screen's context bar shows. */
export function contextTitle(pathname: string): string {
  const index = placeIndexFor(pathname);
  if (index !== null) return PLACE_NAME[index];
  return routeForPath(pathname)?.title ?? '';
}
