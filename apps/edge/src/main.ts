// Stateless Lightsail forwarder: listeners, PROXY v2, per-IP caps, 421 when home is gone.
// Placeholder entrypoint until its phase lands; the image dispatches `postroom edge` here.
import { describeDaemon } from './daemon.js';

console.log(describeDaemon());
