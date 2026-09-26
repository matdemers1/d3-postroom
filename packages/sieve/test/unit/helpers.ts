import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileScript, execute, messageFromMime, type ExecuteOptions, type SieveAction, type SieveMessage, type SieveResult } from '../../src/index.js';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'rfc');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export interface MessageSpec {
  headers?: Record<string, string | string[]>;
  /** The body, after the blank line. Defaults to a short text line. */
  body?: string;
  envelopeFrom?: string;
  envelopeTo?: string;
  /** Default headers to leave out. */
  omit?: string[];
}

/** Build a CRLF message and wrap it with messageFromMime. */
export function message(spec: MessageSpec = {}): SieveMessage {
  const lines: string[] = [];
  const headers = { From: 'sender@example.org', To: 'me@example.com', Subject: 'hello', Date: 'Fri, 25 Sep 2026 10:00:00 +0000', ...spec.headers };
  for (const [name, value] of Object.entries(headers)) {
    if (spec.omit?.includes(name)) continue;
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
  }
  const raw = `${lines.join('\r\n')}\r\n\r\n${(spec.body ?? 'Hello there.\r\n').replace(/\r?\n/g, '\r\n')}`;
  return messageFromMime(raw, { from: spec.envelopeFrom ?? 'sender@example.org', to: spec.envelopeTo ?? 'me@example.com' });
}

function flags(f: readonly string[] | null): string {
  return f === null || f.length === 0 ? '' : ` [${f.join(' ')}]`;
}

/** One line per action, compact enough to write expectations by hand. */
export function describeAction(a: SieveAction): string {
  switch (a.type) {
    case 'keep':
      return `keep ${a.mailbox}${flags(a.flags)}${a.implicit ? ' (implicit)' : ''}`;
    case 'fileinto':
      return `fileinto ${a.mailbox}${flags(a.flags)}${a.create ? ' :create' : ''}`;
    case 'discard':
      return 'discard';
    case 'redirect':
      return `redirect ${a.address}${a.allowed ? '' : ' (refused)'}`;
    case 'vacation':
      return `vacation to ${a.to} days ${a.days} subject "${a.subject}"${a.respond ? '' : ` (suppressed: ${a.suppressed ?? ''})`}`;
  }
}

export function summarize(result: SieveResult): string[] {
  return result.actions.map(describeAction);
}

export function run(source: string, msg: SieveMessage = message(), options: ExecuteOptions = {}): SieveResult {
  return execute(compileScript(source), msg, options);
}
