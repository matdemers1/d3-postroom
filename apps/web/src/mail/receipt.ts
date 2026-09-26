// When the reading pane offers a read receipt (PST-T-9.2, PST-REQ-146, RFC 8098 §2.1): the message
// asked for one with Disposition-Notification-To, and no receipt has been sent ($MDNSent, the
// RFC 3503 keyword other clients also honour). Messages we sent ourselves never ask us.
import type { MessageBody, MessageDetail } from '../api';

export function wantsReceipt(detail: Pick<MessageDetail, 'flags'>, body: Pick<MessageBody, 'headers'> | null, ownMailbox: boolean): boolean {
  if (body === null || ownMailbox) return false;
  if (detail.flags.includes('$MDNSent')) return false;
  return body.headers.some((h) => h.name.toLowerCase() === 'disposition-notification-to' && h.value.trim() !== '');
}
