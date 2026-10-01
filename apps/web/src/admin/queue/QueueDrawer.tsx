// PST-T-16.13 (PST-DA-031): a queue row's evidence, in the same end-edge sheet Inspect uses. The row
// shows who and what state; here is why — the receiving server's last reply and every attempt, drawn
// by the reading pane's own DeliveryEvidence so the two can never word the same attempt differently.
import { useEffect, useState } from 'react';
import { Button, Modal, ModalClose } from '@d3cloud/ui';
import { api, type AdminQueueRecipient, type DeliveryRecipient } from '../../api';
import { DeliveryEvidence } from '../../mail/DeliveryRows';
import { Loading, LoadFailed } from '../../screens/states';
import { lastResponse } from './model';

export function QueueDrawer({
  row,
  onClose,
  onlyThisMessage,
}: {
  row: AdminQueueRecipient | null;
  onClose: () => void;
  /** Shown when the list is not already filtered to this message. */
  onlyThisMessage: ((messageId: string) => void) | null;
}) {
  const [detail, setDetail] = useState<{ id: string; recipients: DeliveryRecipient[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const rowId = row?.id ?? null;
  const messageId = row?.outboundMessageId ?? null;

  useEffect(() => {
    if (rowId === null || messageId === null) return;
    let live = true;
    setDetail(null);
    setError(null);
    api
      .messageDelivery(messageId)
      .then((d) => {
        if (live) setDetail({ id: rowId, recipients: d.recipients.filter((r) => r.id === rowId) });
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      });
    return () => {
      live = false;
    };
  }, [rowId, messageId, attempt]);

  const last = row === null ? null : lastResponse(row);
  return (
    <Modal
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Delivery details"
      description={row === null ? '' : <span className="pr-mono">{row.address}</span>}
      size="lg"
      className="pr-inspect"
      footer={
        <>
          {row !== null && onlyThisMessage !== null ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onlyThisMessage(row.outboundMessageId);
              }}
            >
              Show only this message
            </Button>
          ) : null}
          <ModalClose>
            <Button type="button">Close</Button>
          </ModalClose>
        </>
      }
    >
      {row === null ? null : (
        <div className="pr-queue-drawer">
          <section aria-labelledby="pr-queue-last" className="pr-inspect__section" data-testid="queue-last-response">
            <h3 id="pr-queue-last" className="pr-inspect__h3">
              Last response
            </h3>
            {last === null ? <p className="pr-muted">The receiving server hasn’t replied yet.</p> : <p className="pr-mono pr-queue-drawer__reply">{last}</p>}
          </section>
          {error !== null ? (
            <LoadFailed
              error={error}
              what="the delivery attempts"
              headingLevel={3}
              onRetry={() => {
                setAttempt((n) => n + 1);
              }}
            />
          ) : detail === null || detail.id !== row.id ? (
            <Loading label="Loading the delivery attempts" height={96} />
          ) : detail.recipients.length === 0 ? (
            <p className="pr-muted">No delivery record for this recipient.</p>
          ) : (
            <DeliveryEvidence recipients={detail.recipients} />
          )}
        </div>
      )}
    </Modal>
  );
}
