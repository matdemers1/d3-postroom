// A dedicated LISTEN connection, outside Prisma's pool (Prisma cannot receive notifications).
//
// `pg` is not yet a direct dependency of @postroom/api, so it is loaded from @postroom/db's own
// dependency tree (the same pinned version the whole repo uses). When apps/api/package.json gains
// `pg` itself, replace this with `import pg from 'pg'`; the interface below is all this app uses.
import { createRequire } from 'node:module';

export interface ListenClient {
  connect: () => Promise<void>;
  query: (sql: string) => Promise<unknown>;
  end: () => Promise<void>;
  on(event: 'notification', listener: (msg: { channel: string; payload?: string | undefined }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

type ClientCtor = new (options: { connectionString: string }) => ListenClient;

let ctor: ClientCtor | undefined;

function loadPg(): ClientCtor {
  if (ctor !== undefined) return ctor;
  const require = createRequire(import.meta.resolve('@postroom/db'));
  const pg = require('pg') as { Client: ClientCtor };
  ctor = pg.Client;
  return ctor;
}

export interface ListenHandlers {
  notify: (payload: string) => void;
  /** The connection failed or ended; it will not deliver again. */
  lost: (error: Error | null) => void;
}

/** Connects and issues LISTEN on `channel`, with the handlers attached before the LISTEN. */
export async function openListener(connectionString: string, channel: string, on: ListenHandlers): Promise<ListenClient> {
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error(`bad channel name ${channel}`);
  const Client = loadPg();
  const client = new Client({ connectionString });
  client.on('notification', (msg) => {
    if (msg.channel === channel && msg.payload !== undefined) on.notify(msg.payload);
  });
  client.on('error', (error) => {
    on.lost(error);
  });
  client.on('end', () => {
    on.lost(null);
  });
  await client.connect();
  await client.query(`LISTEN ${channel}`);
  return client;
}
