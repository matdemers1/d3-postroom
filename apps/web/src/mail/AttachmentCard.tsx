// An attachment as a card (PST-T-15.3, the redesign canvas's `.pr-file`): a file-type tile ("PDF",
// "PNG"), the file's name, its size, and a download mark. Mail-only, so it lives here rather than in
// @d3cloud/ui, and it is drawn from the system's tokens (AttachmentCard.css).
//
// The whole card is ONE real link to the attachment's existing URL with the `download` attribute —
// exactly what the reading pane's attachment chips were before. The server always answers with
// `application/octet-stream`, `Content-Disposition: attachment` and a sandbox CSP
// (apps/api/src/mail/index.ts), so an attachment is never opened inline on this origin; "open" and
// "download" are the same act, and the card offers it once rather than as two tab stops.
//
// The tile is neutral on purpose: a file type is not something that needs you (D-016), so it takes
// no hue. Its letters are decorative — the link's own name says which file it is and how big.
import type { MessageAttachment } from '../api';
import { attachmentUrl } from '../api';
import { byteSize } from './format';
import { DownloadIcon } from './thread/icons';
import './AttachmentCard.css';

/** The words an attachment is called by: its filename, else "Part 2". */
export function attachmentName(a: Pick<MessageAttachment, 'filename' | 'partId'>): string {
  return a.filename ?? `Part ${a.partId}`;
}

/**
 * The tile's letters: the filename's extension ("PDF", "DOCX" → "DOCX"), else the content type's
 * subtype when it is short and plain ("image/png" → "PNG"), else "FILE". At most four characters.
 */
export function fileTypeLabel(filename: string | null, contentType: string | null | undefined): string {
  const name = (filename ?? '').trim();
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) {
    const ext = name.slice(dot + 1);
    if (/^[a-z0-9]{1,4}$/i.test(ext)) return ext.toUpperCase();
  }
  const subtype = (contentType ?? '').split(';')[0]?.split('/')[1]?.trim() ?? '';
  if (/^[a-z0-9]{1,4}$/i.test(subtype)) return subtype.toUpperCase();
  return 'FILE';
}

/** Which of a body's parts are shown as attachments: anything marked as one, or anything named. */
export function listedAttachments(attachments: readonly MessageAttachment[] | undefined): MessageAttachment[] {
  return (attachments ?? []).filter((a) => a.disposition === 'attachment' || a.filename !== null);
}

export function AttachmentCard({ messageId, attachment }: { messageId: string; attachment: MessageAttachment }) {
  const name = attachmentName(attachment);
  const size = byteSize(attachment.size);
  return (
    <a
      className="pr-file"
      href={attachmentUrl(messageId, attachment.partId)}
      download={attachment.filename ?? `part-${attachment.partId}`}
      aria-label={`Download ${name}, ${size}`}
      data-testid="attachment"
    >
      <span className="pr-file__tile" aria-hidden="true">
        {fileTypeLabel(attachment.filename, attachment.contentType)}
      </span>
      <span className="pr-file__text">
        <span className="pr-file__name">{name}</span>
        <span className="pr-file__size">{size}</span>
      </span>
      <span className="pr-file__action" aria-hidden="true">
        <DownloadIcon />
      </span>
    </a>
  );
}

/** A message's attachments as a wrapping row of cards; nothing at all when it has none. */
export function AttachmentList({ messageId, attachments }: { messageId: string; attachments: readonly MessageAttachment[] | undefined }) {
  const shown = listedAttachments(attachments);
  if (shown.length === 0) return null;
  return (
    <section aria-label="Attachments" className="pr-files">
      <ul className="pr-files__list">
        {shown.map((a) => (
          <li key={a.partId}>
            <AttachmentCard messageId={messageId} attachment={a} />
          </li>
        ))}
      </ul>
    </section>
  );
}
