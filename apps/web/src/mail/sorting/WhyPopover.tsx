// PST-T-14.9 (TF-12, TF-I5, MOD-I8): "Why it's here". One plain sentence from the message's STORED
// sorting reasons (GET /api/messages/:id → verdict.reasons; nothing is recomputed, no model is
// asked), and the corrections, each one move:
//
//   · Always put <sender or domain> in <bucket> — records the preference for where it already is;
//   · Move this message to <bucket> — the move plus a sender preference, so their next one goes there;
//   · Somewhere else… — the other buckets;
//   · Open Rules — Settings → Rules, where every correction is listed with Undo.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type MessageSummary } from '../../api';
import { useMediaQuery, SPLIT_QUERY } from '../useMedia';
import { Floating } from './Floating';
import { alwaysPut, BUCKET_LABEL, isFilingBucket, otherBuckets, suggestedMove, whySentence, type FilingBucket } from './sorting';

export const RULES_CORRECTIONS_PATH = '/settings/rules#sorting-corrections';

export interface WhyPopoverProps {
  message: MessageSummary;
  anchor: DOMRect;
  returnFocus: HTMLElement | null;
  opener?: HTMLElement | null;
  onClose: () => void;
  onCorrect: (bucket: FilingBucket, scope: 'sender' | 'domain') => void;
}

export function WhyPopover({ message, anchor, returnFocus, opener = null, onClose, onCorrect }: WhyPopoverProps) {
  const navigate = useNavigate();
  const wide = useMediaQuery(SPLIT_QUERY);
  const [reasons, setReasons] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let live = true;
    api.message(message.id).then(
      (d) => {
        if (live) setReasons(d.verdict?.reasons ?? []);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [message.id]);

  const bucket = isFilingBucket(message.bucket) ? message.bucket : null;
  if (bucket === null) return null;
  const always = alwaysPut(message.from, message.fromName, bucket);
  const move = suggestedMove(bucket);
  const pick = (to: FilingBucket, scope: 'sender' | 'domain') => {
    onClose();
    onCorrect(to, scope);
  };

  return (
    <Floating anchor={anchor} returnFocus={returnFocus} opener={opener} label="Why it's here" sheet={!wide} onClose={onClose} className="pr-why" testId="why-popover">
      <p className="pr-why__eyebrow">
        <span className="pr-chip pr-chip--static" data-bucket={bucket}>
          {BUCKET_LABEL[bucket]}
        </span>
        Why it’s here
      </p>
      <p className="pr-why__sentence" data-testid="why-sentence">
        {failed ? 'The reasons for this decision could not be loaded.' : reasons === null ? 'Loading the reasons…' : whySentence(bucket, reasons)}
      </p>
      <div className="pr-why__actions" role="group" aria-label="Correct it">
        {always === null ? null : (
          <button type="button" className="pr-why__action" data-autofocus onClick={() => { pick(always.bucket, always.scope); }}>
            {always.label}
          </button>
        )}
        <button type="button" className="pr-why__action" onClick={() => { pick(move, 'sender'); }}>
          Move this message to {BUCKET_LABEL[move]}
        </button>
        <button type="button" className="pr-why__action pr-why__action--quiet" aria-expanded={more} onClick={() => { setMore((v) => !v); }}>
          Somewhere else…
        </button>
        {more
          ? otherBuckets(bucket).map((b) => (
              <button key={b} type="button" className="pr-why__action pr-why__action--sub" onClick={() => { pick(b, 'sender'); }}>
                Move this message to {BUCKET_LABEL[b]}
              </button>
            ))
          : null}
        <button
          type="button"
          className="pr-why__action pr-why__action--quiet"
          onClick={() => {
            onClose();
            void navigate(RULES_CORRECTIONS_PATH);
          }}
        >
          Open Rules
        </button>
      </div>
      <p className="pr-why__foot">Reasons from the stored decision · every score is in Inspect</p>
    </Floating>
  );
}
