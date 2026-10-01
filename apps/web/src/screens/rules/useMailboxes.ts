import { useEffect, useState } from 'react';
import { api, type Mailbox } from '../../api';
import { useOptionalMail } from '../../mail/MailContext';

/** The account's mailboxes for the destination picker: the shell's live list, else one fetch. Null until known. */
export function useMailboxes(): Mailbox[] | null {
  const mail = useOptionalMail();
  const [fetched, setFetched] = useState<Mailbox[] | null>(null);
  const shared = mail?.mailboxes ?? null;
  useEffect(() => {
    if (shared !== null) return;
    let live = true;
    api
      .mailboxes()
      .then((r) => {
        if (live) setFetched(r.mailboxes);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [shared]);
  return shared ?? fetched;
}
