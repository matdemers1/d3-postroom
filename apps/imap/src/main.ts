// IMAP4rev1/rev2 on :993.
// Placeholder entrypoint until its phase lands; the image dispatches `postroom imap` here.
import { describeDaemon } from './daemon.js';

console.log(describeDaemon());
