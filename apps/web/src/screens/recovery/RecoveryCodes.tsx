import './recovery.css';
import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Cluster, FormActions, Stack } from '@d3cloud/ui';
import { displayCode, RECOVERY_FILENAME, recoveryCodesClipboard, recoveryCodesText, SAVED_LABEL } from './codes';

/** Triggers a browser download of text without navigating away from the screen. */
function downloadText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Ten freshly issued recovery codes (PST-REQ-197), shown this once: Copy all, Download .txt, and an
 * "I have saved these" checkbox that gates the way on. Nothing here can fetch them again — the
 * server keeps only their hashes — so leaving this screen is the last time they are visible.
 */
export function RecoveryCodes({
  codes,
  address,
  createdAt,
  continueLabel,
  onContinue,
  busy = false,
}: {
  codes: readonly string[];
  address?: string | null;
  createdAt: Date;
  continueLabel: string;
  onContinue: () => void;
  busy?: boolean;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => {
      setCopied(false);
    }, 2_000);
    return () => {
      clearTimeout(t);
    };
  }, [copied]);

  return (
    <Stack gap="16">
      <Alert tone="warning" title="Save these now">
        Each code works once, in place of a code from your authenticator app — for the day your phone is lost.
        You won’t see them again.
      </Alert>
      <ol className="pr-recovery-codes" aria-label="Recovery codes" data-testid="recovery-codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{displayCode(code)}</code>
          </li>
        ))}
      </ol>
      <Cluster gap="8">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard
              .writeText(recoveryCodesClipboard(codes))
              .then(() => {
                setCopied(true);
              })
              .catch(() => undefined);
          }}
        >
          {copied ? 'Copied' : 'Copy all'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            downloadText(recoveryCodesText(codes, { address: address ?? null, createdAt }), RECOVERY_FILENAME);
          }}
        >
          Download .txt
        </Button>
      </Cluster>
      <Checkbox
        label={SAVED_LABEL}
        checked={saved}
        onCheckedChange={(c) => {
          setSaved(c === true);
        }}
      />
      <FormActions layout="stack">
        <Button type="button" variant="primary" disabled={!saved} loading={busy} onClick={onContinue}>
          {continueLabel}
        </Button>
      </FormActions>
    </Stack>
  );
}
