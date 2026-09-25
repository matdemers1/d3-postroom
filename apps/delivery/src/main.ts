// Outbound delivery queue.
// Placeholder entrypoint until its phase lands; the image dispatches `postroom delivery` here.
import { describeDaemon } from './daemon.js';

console.log(describeDaemon());
