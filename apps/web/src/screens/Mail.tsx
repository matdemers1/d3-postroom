import '../mail/mail.css';
import { MailView } from '../mail/MailView';

/**
 * Mail (PST-T-3.10): the three-pane view — the shell's sidebar holds the mailboxes, then the
 * message list and the reading pane; push navigation below tablet width.
 */
export function Mail() {
  return <MailView />;
}
