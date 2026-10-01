import { useEffect, useState } from 'react';
import { FormField, IconButton, Input, Textarea } from '@d3cloud/ui';
import './wizard.css';

function CopyGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function DoneGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Copies one value. Its name says what ("Copy dkim-ed record value") and, for a moment after a copy,
 * that it happened ("Copied …"), so a screen reader hears it too; the icon turns to a ✓ for the eye.
 */
export function CopyIconButton({ value, label }: { value: string; label: string }) {
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
    <IconButton
      variant="secondary"
      size="md"
      className="pr-copyfield__copy"
      icon={copied ? <DoneGlyph /> : <CopyGlyph />}
      label={copied ? `Copied ${label}` : `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
          })
          .catch(() => undefined);
      }}
    />
  );
}

/** A value that would not fit a phone-width field is shown in two lines, not one that scrolls sideways. */
export const LONG_VALUE = 24;

/**
 * A value to publish somewhere else, as a read-only field in the mono face with a Copy button beside
 * it (admin critique 2.9 #6). The field is 24rem at most, like every field in the wizard; a long value
 * (a DKIM key, a TXT record) is a two-line read-only textarea that scrolls inside itself.
 */
export function CopyField({
  label,
  value,
  copyLabel,
  name,
  oneLine = false,
}: {
  /** The visible label: "Name", "Value". */
  label: string;
  value: string;
  /** What the Copy button copies, after "Copy ": "dkim-ed record value". */
  copyLabel: string;
  /** The field's accessible name when several rows share one visible label ("SPF record name"). */
  name?: string;
  /** Always one line, however long: a host name reads (and scrolls) as one. */
  oneLine?: boolean;
}) {
  const named = name === undefined ? {} : { 'aria-label': name };
  return (
    <FormField label={label} width="lg">
      <div className="pr-copyfield">
        {!oneLine && value.length > LONG_VALUE ? (
          <Textarea appearance="filled" mono readOnly rows={2} value={value} spellCheck={false} {...named} />
        ) : (
          <Input appearance="filled" className="pr-copyfield__mono" readOnly value={value} spellCheck={false} {...named} />
        )}
        <CopyIconButton value={value} label={copyLabel} />
      </div>
    </FormField>
  );
}
