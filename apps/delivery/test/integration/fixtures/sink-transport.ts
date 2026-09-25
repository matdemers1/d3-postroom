// A minimal SMTP client for the kill -9 test: enough of RFC 5321 to hand one message to the test's
// TCP sink over a real socket, streaming the body from the blob store. The real client (TLS, MX
// selection, pipelining, dot-stuffing of arbitrary input) is PST-T-1.6; the fixture message has no
// line starting with '.', so no stuffing is needed here.
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import type { AttemptOutcome } from '../../../src/state.js';
import type { DeliveryRequest, DeliveryResult, Transport } from '../../../src/transports/types.js';

class Replies {
  private buffer = '';
  private readonly waiting: ((line: { code: number; text: string } | Error) => void)[] = [];
  private readonly ready: ({ code: number; text: string } | Error)[] = [];

  constructor(socket: Socket) {
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\r\n')) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 2);
        if (line.charAt(3) === '-') continue;
        this.push({ code: Number(line.slice(0, 3)), text: line.slice(4) });
      }
    });
    const fail = (error: Error): void => { this.push(error); };
    socket.on('error', fail);
    socket.on('close', () => { fail(new Error('connection closed')); });
  }

  private push(item: { code: number; text: string } | Error): void {
    const w = this.waiting.shift();
    if (w === undefined) this.ready.push(item);
    else w(item);
  }

  async next(): Promise<{ code: number; text: string }> {
    const item = this.ready.shift() ?? (await new Promise<{ code: number; text: string } | Error>((resolve) => { this.waiting.push(resolve); }));
    if (item instanceof Error) throw item;
    return item;
  }
}

function outcome(code: number, text: string): AttemptOutcome {
  if (code >= 200 && code < 300) return { kind: 'delivered', code, text };
  if (code >= 500) return { kind: 'permanent', code, text };
  return { kind: 'temporary', code, text };
}

export function sinkTransport(port: number): Transport {
  return {
    name: 'sink',
    deliver: async (request: DeliveryRequest): Promise<DeliveryResult> => {
      const socket = connect(port, '127.0.0.1');
      request.signal.addEventListener('abort', () => { socket.destroy(new Error('attempt aborted')); });
      const replies = new Replies(socket);
      const expect = async (want: number): Promise<{ code: number; text: string }> => {
        const r = await replies.next();
        if (Math.floor(r.code / 100) !== want) throw new Error(`unexpected reply ${r.code} ${r.text}`);
        return r;
      };
      const send = (line: string): void => { socket.write(`${line}\r\n`); };
      await expect(2);
      send('EHLO sender.test');
      await expect(2);
      send(`MAIL FROM:<${request.envelopeFrom}>`);
      await expect(2);
      const results: Record<string, AttemptOutcome> = {};
      const accepted: string[] = [];
      for (const r of request.recipients) {
        send(`RCPT TO:<${r.address}>`);
        const rep = await replies.next();
        if (rep.code >= 200 && rep.code < 300) accepted.push(r.id);
        else results[r.id] = outcome(rep.code, rep.text);
      }
      send('DATA');
      await expect(3);
      const stream = await request.message();
      for await (const chunk of stream) {
        if (!socket.write(chunk as Buffer)) await once(socket, 'drain');
      }
      socket.write('.\r\n');
      const final = await replies.next();
      for (const id of accepted) results[id] = outcome(final.code, final.text);
      // Resolve on the DATA reply; QUIT after (the transport contract).
      send('QUIT');
      socket.end();
      return { details: { mxHost: 'sink.test', mxIp: '127.0.0.1' }, results };
    },
  };
}
