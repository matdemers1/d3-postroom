// PST-T-4.11: the api tests' `request(app)` must bind the app to 127.0.0.1 itself. supertest's own
// binds the dual-stack wildcard and dials 127.0.0.1, so another process's 127.0.0.1:<port> listener
// could answer instead (the 404/405/501, `socket hang up` and hang flakes).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import supertest from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { request } from '../loopback.js';

function echo(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ local: req.socket.localAddress, method: req.method, url: req.url }));
}

const closed = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });

describe('request(app) from test/loopback', () => {
  let squatter: Server | null = null;
  afterEach(async () => {
    if (squatter !== null) await closed(squatter);
    squatter = null;
  });

  it('serves the app on an IPv4-specific 127.0.0.1 listener, not the dual-stack wildcard', async () => {
    const res = await request(echo).post('/x?y=1').send({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ local: '127.0.0.1', method: 'POST', url: '/x?y=1' });
  });

  it('keeps supertest assertions working', async () => {
    await request(echo).get('/ok').expect(200).expect('content-type', /json/);
    await expect(request(echo).get('/ok').expect(418)).rejects.toThrow(/expected 418/);
  });

  it('is what the old way was not: the wildcard bind loses 127.0.0.1:<port> to a specific listener', async () => {
    // The failure mode, reproduced deterministically: something else holds 127.0.0.1:<port>, and a
    // wildcard listener on that same port (what supertest's app.listen(0) makes) is still allowed.
    squatter = createServer((_req, res) => {
      res.writeHead(501);
      res.end('someone else');
    });
    const held = squatter;
    await new Promise<void>((resolve) => {
      held.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const port = (held.address() as AddressInfo).port;
    const wildcard = createServer(echo);
    const bound = await new Promise<boolean>((resolve) => {
      wildcard.once('error', () => {
        resolve(false);
      });
      wildcard.listen(port, () => {
        resolve(true);
      });
    });
    if (bound) {
      // Dual-stack host (macOS): supertest would dial 127.0.0.1 and reach the squatter.
      const res = await supertest(wildcard).get('/');
      expect(res.status).toBe(501);
      await closed(wildcard);
    }
    // Either way, the loopback helper reaches the app.
    expect((await request(echo).get('/')).status).toBe(200);
  });
});
