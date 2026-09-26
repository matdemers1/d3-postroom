// The composer's frame: the right fields, prefilled for a reply, reply-all, forward or a new
// message (compose.ts). Sending, drafts and attachments are PST-T-3.11, which fills this in; until
// then Send says so rather than pretending.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, FormActions, FormField, Input, Stack, Textarea } from '@d3cloud/ui';
import type { ComposeDraft } from './compose';

const TITLES: Readonly<Record<ComposeDraft['mode'], string>> = {
  new: 'New message',
  reply: 'Reply',
  replyall: 'Reply all',
  forward: 'Forward',
};

export function Composer({ draft, onDiscard, back }: { draft: ComposeDraft; onDiscard: () => void; back?: ReactNode }) {
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState(draft.cc);
  const [subject, setSubject] = useState(draft.subject);
  const [text, setText] = useState(draft.body);
  const toRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // A reply already knows who it is for: start in the text, at the top, above the quote.
  useEffect(() => {
    if (draft.to === '') toRef.current?.focus();
    else {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(0, 0);
    }
  }, [draft.to]);

  return (
    <section
      className="pr-reader pr-composer"
      aria-labelledby="pr-composer-title"
      data-compose-mode={draft.mode}
      data-in-reply-to={draft.inReplyTo ?? ''}
      data-references={draft.references.join(' ')}
      data-source-id={draft.sourceId ?? ''}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDiscard();
        }
      }}
    >
      {back}
      <Stack
        as="form"
        gap="16"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <h2 id="pr-composer-title" className="pr-reader__subject">
          {TITLES[draft.mode]}
        </h2>
        <FormField label="To">
          <Input ref={toRef} value={to} autoComplete="off" onChange={(e) => { setTo(e.target.value); }} />
        </FormField>
        <FormField label="Cc" optional>
          <Input value={cc} autoComplete="off" onChange={(e) => { setCc(e.target.value); }} />
        </FormField>
        <FormField label="Subject">
          <Input value={subject} onChange={(e) => { setSubject(e.target.value); }} />
        </FormField>
        <FormField label="Message">
          <Textarea ref={bodyRef} rows={12} value={text} onChange={(e) => { setText(e.target.value); }} />
        </FormField>
        <FormActions leading={<Button type="button" variant="ghost" onClick={onDiscard}>Discard</Button>}>
          <Button type="submit" variant="primary" disabled aria-describedby="pr-composer-soon">
            Send
          </Button>
        </FormActions>
        <p id="pr-composer-soon" className="pr-reader__note">
          Sending from the web arrives with the next update. Your mail client can send now.
        </p>
      </Stack>
    </section>
  );
}
