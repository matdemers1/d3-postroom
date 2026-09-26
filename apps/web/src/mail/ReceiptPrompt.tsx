// PST-T-9.2, PST-REQ-146: "The sender asked for a read receipt — Send / Don't send." Shown once, at
// the top of a message that carries Disposition-Notification-To, offering to send an RFC 8098 MDN
// (POST /api/messages/:id/mdn) for it. A pure, self-contained component — it fetches nothing itself
// beyond that one POST, and holds no state the reading pane needs to know about beyond the two
// callbacks below.
//
// Not mounted here: the lead wires this into ReadingPane.tsx once, next to the message it answers.
//
// Props:
//   - messageId: the inbound message that asked for a receipt.
//   - onSent?: called after the MDN is sent (e.g. so the reading pane can hide the prompt for good,
//     or note $MDNSent locally without a refetch).
//   - onDismiss?: called when "Don't send" is chosen; the prompt is not shown again for this
//     message this session unless the caller decides otherwise (that policy is the caller's, not
//     this component's — it has no memory of its own beyond its own mounted lifetime).
import { useState } from 'react';
import { Alert, Button, Cluster } from '@d3cloud/ui';
import { ApiError } from '../api';
import { mdnApi } from '../compose/api';

export function ReceiptPrompt({ messageId, onSent, onDismiss }: { messageId: string; onSent?: () => void; onDismiss?: () => void }) {
  const [state, setState] = useState<'asking' | 'sending' | 'sent' | 'dismissed' | 'failed'>('asking');
  const [error, setError] = useState<string | null>(null);

  if (state === 'sent' || state === 'dismissed') return null;

  const send = async () => {
    setState('sending');
    setError(null);
    try {
      await mdnApi.send(messageId);
      setState('sent');
      onSent?.();
    } catch (e) {
      setState('asking');
      setError(e instanceof ApiError && e.code === 'already_sent' ? 'A read receipt for this message was already sent.' : 'The read receipt could not be sent. Try again.');
    }
  };

  return (
    <Alert
      tone="info"
      title="The sender asked for a read receipt"
      data-testid="receipt-prompt"
      actions={
        <Cluster gap="8">
          <Button
            size="sm"
            variant="primary"
            loading={state === 'sending'}
            onClick={() => {
              void send();
            }}
          >
            Send
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={state === 'sending'}
            onClick={() => {
              setState('dismissed');
              onDismiss?.();
            }}
          >
            Don't send
          </Button>
        </Cluster>
      }
    >
      {error ?? 'Sending one confirms only that you displayed the message, not that you read it.'}
    </Alert>
  );
}
