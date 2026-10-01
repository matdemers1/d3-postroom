// PST-T-14.9: the bucket chip in a message header — a real button, so the keyboard reaches "Why it's
// here" too (a list row's chip is part of its option and opens the same popover by pointer). It shows
// by the same rule as the rows: the open message where the list does not imply its bucket (search,
// the Inbox's Everything), and a thread member filed in a different bucket from the open message.
//
// PST-T-16.21: inside a bucket folder or Junk the chip stays away on purpose (the folder says it), so
// the open message gets HeaderWhyControl instead: a quiet text button, "Why it's here", that opens the
// same popover with the sentence and the corrections. It is never a positive "Verified"-style chip
// (BRAND-04): it asks a question rather than certifying anything.
import { useRef, useState } from 'react';
import type { MessageSummary } from '../../api';
import { useSorting } from './SortingContext';
import { BUCKET_LABEL, chipShows, isFilingBucket, whyPlacement, type ChipContext, type FilingBucket } from './sorting';
import { WhyPopover } from './WhyPopover';

export function HeaderBucketChip({ message }: { message: MessageSummary }) {
  const sorting = useSorting();
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (sorting === null || !isFilingBucket(message.bucket)) return null;
  const context = message.id === sorting.openId ? sorting.list : ({ kind: 'thread', openBucket: sorting.openBucket } as const);
  if (!chipShows(message.bucket, context)) return null;
  const label = BUCKET_LABEL[message.bucket];
  return (
    <>
      <button
        ref={button}
        type="button"
        className="pr-chip"
        data-bucket={message.bucket}
        data-testid="bucket-chip"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-label={`${label}: why it's here`}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor((a) => (a === null ? rect : null));
        }}
      >
        {label}
      </button>
      {anchor === null ? null : (
        <WhyPopover
          message={message}
          anchor={anchor}
          returnFocus={button.current}
          opener={button.current}
          onClose={() => {
            setAnchor(null);
          }}
          onCorrect={(bucket, scope) => {
            sorting.correct(message, bucket, scope, 'chip');
          }}
        />
      )}
    </>
  );
}

/**
 * The quiet "Why it's here" control, in a bucket folder or Junk (where there is no chip). In the reading
 * pane it is the open message's; in the Newsletters feed there is no open message, so a feed item
 * passes the folder it is rendered in as `list` and hears about a correction through `onCorrected`.
 */
export function HeaderWhyControl({
  message,
  list,
  onCorrected,
}: {
  message: MessageSummary;
  list?: ChipContext;
  onCorrected?: (bucket: FilingBucket) => void;
}) {
  const sorting = useSorting();
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (sorting === null) return null;
  if (list === undefined && message.id !== sorting.openId) return null;
  const placement = whyPlacement(message.bucket, list ?? sorting.list);
  if (placement === null) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="pr-why-control"
        data-testid="why-control"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor((a) => (a === null ? rect : null));
        }}
      >
        Why it’s here
      </button>
      {anchor === null ? null : (
        <WhyPopover
          message={message}
          placement={placement}
          anchor={anchor}
          returnFocus={button.current}
          opener={button.current}
          onClose={() => {
            setAnchor(null);
          }}
          onCorrect={(bucket, scope) => {
            sorting.correct(message, bucket, scope, 'chip');
            onCorrected?.(bucket);
          }}
        />
      )}
    </>
  );
}
