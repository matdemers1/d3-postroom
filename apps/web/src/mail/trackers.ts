// The count badge for PST-REQ-116: what the server removed from a message before rendering it.
import type { RenderTicket } from '../api';

export function trackersBlockedNote(ticket: Pick<RenderTicket, 'trackersBlocked' | 'linksCleaned'>): string | null {
  const parts: string[] = [];
  if (ticket.trackersBlocked > 0) parts.push(ticket.trackersBlocked === 1 ? '1 tracker blocked' : `${String(ticket.trackersBlocked)} trackers blocked`);
  if (ticket.linksCleaned > 0) parts.push(ticket.linksCleaned === 1 ? '1 link cleaned' : `${String(ticket.linksCleaned)} links cleaned`);
  return parts.length === 0 ? null : parts.join(' · ');
}
