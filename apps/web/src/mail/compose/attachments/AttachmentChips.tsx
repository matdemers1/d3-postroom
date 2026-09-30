// The composer's attachments as chips (PST-T-15.11, PST-REQ-195), drawn like the reading pane's
// AttachmentCard (PST-T-15.3, the canvas's .pr-file): the same neutral type tile and size wording, a
// name that ellipses, then Remove. An uploading chip carries a thin progress bar; a failed one says
// why and offers Retry. The total against the limit shows once it is near (state.ts totalLine).
//
// Screen readers hear an upload start and end through the composer's own live region, never each
// percent; the progress bar is there for anyone who goes looking.
import type { CSSProperties } from 'react';
import { Button, IconButton, Tooltip } from '@d3cloud/ui';
import type { ComposeLimits } from '../../../api';
import { fileTypeLabel } from '../../AttachmentCard';
import { byteSize } from '../../format';
import { CloseIcon } from '../icons';
import { percent, totalLine, type Attachments } from './state';
import '../../AttachmentCard.css';
import './attachments.css';

export interface AttachmentChipsProps {
  items: Attachments;
  limits: ComposeLimits;
  /** A resumed draft's parts too large to carry on, in words: a quiet notice, not chips. */
  omitted?: readonly string[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}

export function AttachmentChips({ items, limits, omitted = [], onRemove, onRetry }: AttachmentChipsProps) {
  const total = totalLine(items, limits);
  if (items.length === 0 && omitted.length === 0) return null;
  return (
    <div className="pr-attach">
      {items.length === 0 ? null : (
        <ul role="list" className="pr-attach__list" aria-label="Attachments">
          {items.map((a) => {
            const pct = percent(a);
            return (
              <li key={a.key} className="pr-attach__chip" data-state={a.kind} data-testid="compose-attachment">
                <span className="pr-file__tile" aria-hidden="true">
                  {fileTypeLabel(a.name, a.contentType)}
                </span>
                <span className="pr-attach__text">
                  <span className="pr-attach__name" title={a.name}>
                    {a.name}
                  </span>
                  <span className="pr-attach__meta">
                    {a.kind === 'uploading' ? `Uploading… ${String(pct)}% of ${byteSize(a.size)}` : a.kind === 'failed' ? (a.retryable ? `Not uploaded. ${a.reason}` : a.reason) : byteSize(a.size)}
                  </span>
                </span>
                {a.kind === 'failed' && a.retryable ? (
                  <Button type="button" size="sm" variant="secondary" aria-label={`Retry ${a.name}`} onClick={() => { onRetry(a.key); }}>
                    Retry
                  </Button>
                ) : null}
                <Tooltip content={`Remove ${a.name}`}>
                  <IconButton type="button" variant="ghost" size="sm" label={`Remove ${a.name}`} icon={<CloseIcon />} onClick={() => { onRemove(a.key); }} />
                </Tooltip>
                {a.kind === 'uploading' ? (
                  <span
                    className="pr-attach__bar"
                    role="progressbar"
                    aria-label={`Uploading ${a.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    style={{ '--pr-attach-progress': `${String(pct)}%` } as CSSProperties}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {omitted.length > 0 ? (
        <ul className="pr-attach__omitted" aria-label="Not carried from the draft" data-testid="compose-attachment-omitted">
          {omitted.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      ) : null}
      {total !== null ? (
        <p className="pr-attach__total" data-testid="compose-attachment-total">
          {total}
        </p>
      ) : null}
    </div>
  );
}
