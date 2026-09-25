// Background jobs: ACME, backups, restore drill.
// Placeholder entrypoint until its phase lands; the image dispatches `postroom worker` here.
import { describeDaemon } from './daemon.js';

console.log(describeDaemon());
