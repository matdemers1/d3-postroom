// pg_dump and pg_restore, injectable (PST-T-0.16, PST-T-0.17). Production runs the image's
// postgresql-client-16 binaries; tests may swap in `docker exec` against a 16 server. The client
// major must match the server: a newer pg_dump writes `SET transaction_timeout`, which 16 refuses.
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface DumpProcess {
  stream: Readable;
  /** Resolves when pg_dump exits 0; rejects with its stderr otherwise. */
  done: Promise<void>;
}

export interface PgTools {
  /** `pg_dump -Fc` of `databaseUrl`: its output, and a promise that settles on its exit code. */
  dump: (databaseUrl: string) => DumpProcess;
  /** Restore a custom-format dump read from `input` into `databaseUrl`; rejects with pg_restore's stderr. */
  restore: (databaseUrl: string, input: Readable) => Promise<void>;
}

export interface CommandPgToolsOptions {
  /** Argv prefix for pg_dump, e.g. ['pg_dump'] or ['docker', 'exec', '-i', 'pst-pg', 'pg_dump']. */
  pgDump?: string[];
  pgRestore?: string[];
  /** Rewrite a URL before handing it to the tool (docker exec sees the server on its own port). */
  mapUrl?: (url: string) => string;
}

const STDERR_LIMIT = 8192;

function collectStderr(stream: Readable): () => string {
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    if (text.length < STDERR_LIMIT) text += chunk.toString('utf8');
  });
  return () => text.trim().slice(0, STDERR_LIMIT);
}

export function commandPgTools(options: CommandPgToolsOptions = {}): PgTools {
  const pgDump = options.pgDump ?? ['pg_dump'];
  const pgRestore = options.pgRestore ?? ['pg_restore'];
  const mapUrl = options.mapUrl ?? ((u: string) => u);

  const dump = (databaseUrl: string): DumpProcess => {
    const [cmd = 'pg_dump', ...pre] = pgDump;
    const child = spawn(cmd, [...pre, '--format=custom', '--no-owner', '--no-privileges', `--dbname=${mapUrl(databaseUrl)}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = collectStderr(child.stderr);
    // The stream ending is not success: pg_dump can die half way and still close stdout cleanly.
    // Only exit code 0 is.
    const done = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pg_dump exited ${code ?? 'by signal'}: ${stderr()}`));
      });
    });
    return { stream: child.stdout, done };
  };

  const restore = (databaseUrl: string, input: Readable): Promise<void> => {
    const [cmd = 'pg_restore', ...pre] = pgRestore;
    const child = spawn(cmd, [...pre, '--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${mapUrl(databaseUrl)}`], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const stderr = collectStderr(child.stderr);
    return new Promise((resolve, reject) => {
      let failed = false;
      const fail = (error: Error): void => {
        if (failed) return;
        failed = true;
        reject(error);
      };
      input.on('error', (error) => {
        child.kill();
        fail(error);
      });
      const stdin: Writable = child.stdin;
      // pg_restore may stop reading once it hits a fatal error; the EPIPE is the symptom, the
      // exit code and stderr are the cause.
      stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') fail(error);
      });
      input.pipe(stdin);
      child.on('error', fail);
      child.on('close', (code) => {
        if (code === 0) {
          if (!failed) resolve();
        } else fail(new Error(`pg_restore exited ${code ?? 'by signal'}: ${stderr()}`));
      });
    });
  };

  return { dump, restore };
}
