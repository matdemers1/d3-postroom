// Inbound SMTP on :25.
// Placeholder entrypoint until its phase lands; the image dispatches `postroom smtp-in` here.
import { describeDaemon } from './daemon.js';

console.log(describeDaemon());
