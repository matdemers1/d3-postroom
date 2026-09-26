// `request(app)` for every api test, bound to 127.0.0.1 rather than the dual-stack wildcard.
//
// Why (PST-T-4.11): supertest's own `request(app)` calls `app.listen(0)`, which binds `::` (IPv4 and
// IPv6, any address), and then connects to `127.0.0.1:<port>`. On macOS, and on any BSD-socket
// dual-stack host, a wildcard bind does not conflict with another process that already holds
// `127.0.0.1:<port>`, and the more specific bind wins the connection. So on a busy machine — other
// suites, the fake issuer, other builders' servers, all on 127.0.0.1:0 — a request now and then
// lands on somebody else's server: a 404, 405 or 501 no route here ever answers, a `socket hang
// up`, or a 30-second hang. Binding the test server to 127.0.0.1 itself makes the port collision
// impossible: two listeners cannot hold the same specific address and port.
//
// Node resolves a listen host asynchronously even for an IP literal, while supertest computes its
// URL synchronously in the constructor, so the bind happens in `end()` — which `await` and `.then`
// both go through — and the URL is filled in once the port is known. One server per request, closed
// after it, exactly as supertest does with its own.
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import supertest from 'supertest';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';
const METHODS: readonly Method[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

type CallbackHandler = Parameters<supertest.Test['end']>[0];

class LoopbackTest extends supertest.Test {
  constructor(
    private readonly loopbackListener: RequestListener,
    method: string,
    private readonly routePath: string,
  ) {
    // A placeholder origin: supertest makes no server for a string, and end() sets the real URL.
    super('http://127.0.0.1:0', method, routePath);
  }

  override end(callback?: CallbackHandler): this {
    const server = createServer(this.loopbackListener);
    server.once('error', (error) => callback?.(error, undefined as never));
    server.listen(0, '127.0.0.1', () => {
      this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${this.routePath}`;
      super.end((error, res) => {
        server.close(() => callback?.(error, res));
        server.closeAllConnections();
      });
    });
    return this;
  }
}

export type LoopbackAgent = Pick<ReturnType<typeof supertest>, Method>;

/** Drop-in for supertest's `request(app)`, for an Express app (or any request listener). */
export function request(app: RequestListener): LoopbackAgent {
  const agent = {} as Record<Method, (path: string) => supertest.Test>;
  for (const method of METHODS) agent[method] = (path) => new LoopbackTest(app, method.toUpperCase(), path);
  return agent;
}
