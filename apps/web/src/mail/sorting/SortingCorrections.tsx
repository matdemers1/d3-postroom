// PST-T-14.9: Settings → Rules → "Sorting corrections". Every time you told Postroom it filed
// something in the wrong place: the correction moved the mail and recorded a sender preference the
// sorter honours from then on. Undo reverses both (the preference, and the move when the message has
// not moved on since); both are in the audit log, and the row is kept, marked undone — never deleted.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Button, EmptyState, Section, Skeleton, Table, type TableColumn } from '@d3cloud/ui';
import { describeError } from '../../api';
import { sortingApi, type SortingCorrection } from './api';
import { bucketLabel, preferenceTarget } from './sorting';
import './sorting.css';

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function SortingCorrections() {
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
    if (location.hash === '#sorting-corrections' && rows !== null) ref.current?.scrollIntoView({ block: 'start' });
  }, [location.hash, rows]);

  const undo = async (c: SortingCorrection) => {
    setBusy(c.id);
    setNotice(null);
    try {
      const r = await sortingApi.undo(c.id);
      const parts = [
        r.preferenceRestored ? `${preferenceTarget(c)} is sorted as before` : `a later choice for ${preferenceTarget(c)} was kept`,
        c.moved ? (r.movedBack ? `the message is back in ${bucketLabel(c.fromBucket)}` : 'the message had moved since, so it was left where it is') : null,
      ].filter((p): p is string => p !== null);
      setNotice({ tone: 'info', text: `Undone: ${parts.join('; ')}.` });
      await load();
    } catch (caught) {
      setNotice({ tone: 'danger', text: describeError(caught) });
    } finally {
      setBusy(null);
    }
  };

  const columns: TableColumn<SortingCorrection>[] = [
    { key: 'when', header: 'When', cell: (c) => <span>{when(c.createdAt)}<br /><span className="pr-person__muted">{c.source === 'card' ? 'from the Person card' : 'from the bucket chip'}</span></span> },
    {
      key: 'what',
      header: 'What you changed',
      cell: (c) => (
        <span className="pr-corrections__what">
          <span className="pr-corrections__subject">{c.subject === null || c.subject === '' ? '(no subject)' : c.subject}</span>
          <span className="pr-corrections__move">
            {c.moved ? `${bucketLabel(c.fromBucket)} → ${bucketLabel(c.toBucket)}` : `Kept in ${bucketLabel(c.toBucket)}`}
            {c.fromAddress === null ? null : ` · ${c.fromAddress}`}
          </span>
        </span>
      ),
    },
    { key: 'learned', header: 'What the sorter learned', cell: (c) => `New mail from ${preferenceTarget(c)} goes to ${bucketLabel(c.toBucket)}, and says so in its reasons.` },
    {
      key: 'undo',
      header: 'Actions',
      align: 'end',
      cell: (c) => (
        <Button size="sm" variant="ghost" loading={busy === c.id} onClick={() => void undo(c)} aria-label={`Undo the correction for ${c.subject === null || c.subject === '' ? preferenceTarget(c) : c.subject}`}>
          Undo
        </Button>
      ),
    },
  ];

  return (
    <div ref={ref} id="sorting-corrections">
      <Section
        title="Sorting corrections"
        description="Every time you told Postroom it filed something in the wrong place. Each correction moved the mail and recorded a preference the sorter uses from then on. Undo reverses both, and both are in the audit log. Nothing is sent to a model."
      >
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
          <EmptyState kind="empty" heading="No corrections yet" headingLevel={3}>
            When a message lands in the wrong bucket, click its bucket chip and pick where it belongs. It shows up here, with Undo.
          </EmptyState>
        ) : (
          <Table caption="Sorting corrections" captionHidden columns={columns} rows={rows} rowKey={(c) => c.id} />
        )}
      </Section>
    </div>
  );
}
