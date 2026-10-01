// PST-T-17.11 (PST-T-14.9): Settings → Rules & sorting → "Sorting corrections", the last card on the
// page. Every time you told Postroom it filed something in the wrong place: the correction moved the
// mail and recorded a sender preference the sorter honours from then on. Undo reverses both (the
// preference, and the move when the message has not moved on since); both are in the audit log, and
// the row is kept, marked undone — never deleted.
//
// Restyled for the canvas from mail/sorting/SortingCorrections.tsx: hairline rows (DataList) instead
// of a four-column table in a 680px card, a relative time, one-line description, and a row-size
// empty state inside its card (critique-settings 2.6 #2, #6; X7).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Button, DataList, DataListRow, EmptyState, Section, Skeleton } from '@d3cloud/ui';
import { describeError } from '../../api';
import { RelativeTime } from '../../components/RelativeTime';
import { sortingApi, type SortingCorrection } from '../../mail/sorting/api';
import { bucketLabel, preferenceTarget } from '../../mail/sorting/sorting';

/** The anchor a bucket chip's "Open Rules" lands on (mail/sorting/WhyPopover.tsx RULES_CORRECTIONS_PATH). */
export const CORRECTIONS_ANCHOR = 'sorting-corrections';

/** The row's title: the message's subject, or what it was about when it had none. */
export function correctionTitle(c: Pick<SortingCorrection, 'subject' | 'target' | 'scope'>): string {
  return c.subject === null || c.subject === '' ? `(no subject) · ${preferenceTarget(c)}` : c.subject;
}

const SOURCE_LABEL: Record<SortingCorrection['source'], string> = {
  chip: 'from the bucket chip',
  card: 'from the Person card',
};

/**
 * One muted line under the subject: where it went, who sent it, where you corrected it, and — when
 * the preference covers a whole domain — that it does.
 * "People → Updates · pat@example.net · from the bucket chip".
 */
export function correctionLine(c: Pick<SortingCorrection, 'moved' | 'fromBucket' | 'toBucket' | 'target' | 'scope' | 'fromAddress' | 'source'>): string {
  const move = c.moved ? `${bucketLabel(c.fromBucket)} → ${bucketLabel(c.toBucket)}` : `Kept in ${bucketLabel(c.toBucket)}`;
  const parts = [move];
  if (c.fromAddress !== null && c.fromAddress !== '') parts.push(c.fromAddress);
  parts.push(SOURCE_LABEL[c.source]);
  // A sender preference is the address already shown; a domain one says how far it reaches.
  if (c.scope === 'domain') parts.push(`learned for ${preferenceTarget(c)}`);
  return parts.join(' · ');
}

/** What Undo did, said in one sentence. */
export function undoneMessage(c: Pick<SortingCorrection, 'moved' | 'fromBucket' | 'target' | 'scope'>, r: { preferenceRestored: boolean; movedBack: boolean }): string {
  const parts = [
    r.preferenceRestored ? `${preferenceTarget(c)} is sorted as before` : `a later choice for ${preferenceTarget(c)} was kept`,
    c.moved ? (r.movedBack ? `the message is back in ${bucketLabel(c.fromBucket)}` : 'the message had moved since, so it was left where it is') : null,
  ].filter((p): p is string => p !== null);
  return `Undone: ${parts.join('; ')}.`;
}

export function Corrections() {
  const [rows, setRows] = useState<SortingCorrection[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setRows((await sortingApi.corrections()).corrections);
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // "Open Rules" from a chip's popover lands here.
  useEffect(() => {
    if (location.hash === `#${CORRECTIONS_ANCHOR}` && rows !== null) ref.current?.scrollIntoView({ block: 'start' });
  }, [location.hash, rows]);

  const undo = async (c: SortingCorrection) => {
    setBusy(c.id);
    setNotice(null);
    try {
      setNotice({ tone: 'info', text: undoneMessage(c, await sortingApi.undo(c.id)) });
      await load();
    } catch (caught) {
      setNotice({ tone: 'danger', text: describeError(caught) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={ref} id={CORRECTIONS_ANCHOR}>
      <Section title="Sorting corrections" description="Each correction you made from a bucket chip, with Undo. Nothing is sent to a model.">
        {notice === null ? null : (
          <Alert tone={notice.tone} dynamic>
            {notice.text}
          </Alert>
        )}
        {error !== null ? (
          <Alert tone="danger" title="Could not load your sorting corrections" actions={<Button size="sm" onClick={() => void load()}>Try again</Button>}>
            {describeError(error)}
          </Alert>
        ) : rows === null ? (
          <Skeleton variant="text" lines={2} />
        ) : rows.length === 0 ? (
          <EmptyState kind="empty" size="row" heading="No corrections yet" headingLevel={3} />
        ) : (
          <DataList aria-label="Sorting corrections">
            {rows.map((c) => (
              <DataListRow
                key={c.id}
                title={correctionTitle(c)}
                description={correctionLine(c)}
                truncate={false}
                meta={<RelativeTime iso={c.createdAt} />}
                actions={
                  <Button size="sm" variant="secondary" loading={busy === c.id} onClick={() => void undo(c)} aria-label={`Undo the correction for ${c.subject === null || c.subject === '' ? preferenceTarget(c) : c.subject}`}>
                    Undo
                  </Button>
                }
              />
            ))}
          </DataList>
        )}
      </Section>
    </div>
  );
}
