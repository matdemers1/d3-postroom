import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { collectHealth, envInt, envString, placeholderListener, startHealthServer } from '../../src/index.js';

describe('env helpers', () => {
  it('treats blank as the default', () => {
    expect(envString({ A: '  ' }, 'A', 'x')).toBe('x');
    expect(envInt({ A: '' }, 'A', 7)).toBe(7);
    expect(envInt({ A: '12' }, 'A', 7)).toBe(12);
    expect(() => envInt({ A: '1.5' }, 'A', 7)).toThrow(/integer/);
  });
});

describe('health', () => {
  it('reports down when a probe throws', async () => {
    const report = await collectHealth('x', { POSTROOM_REVISION: 'abc' }, [
      () => ({ schemaRevision: 'r1' }),
      () => { throw new Error('db gone'); },
    ]);
    expect(report).toMatchObject({ status: 'down', daemon: 'x', revision: 'abc', schemaRevision: 'r1', error: 'db gone' });
  });

  it('serves /health as JSON', async () => {
    const server = await startHealthServer(0, '127.0.0.1', () => collectHealth('y', {}, []));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const res = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', daemon: 'y', revision: 'dev' });
    expect((await fetch(`http://127.0.0.1:${address.port}/other`)).status).toBe(404);
    server.close();
  });
});

describe('placeholder listener', () => {
  it('answers with one CRLF line and closes', async () => {
    const server = await placeholderListener(0, '127.0.0.1', '554 5.3.2 not yet');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const text = await new Promise<string>((resolve, reject) => {
      let data = '';
      const socket = connect(address.port, '127.0.0.1');
      socket.on('data', (chunk: Buffer) => { data += chunk.toString('latin1'); });
      socket.on('end', () => { resolve(data); });
      socket.on('error', reject);
    });
    expect(text).toBe('554 5.3.2 not yet\r\n');
    server.close();
  });
});
