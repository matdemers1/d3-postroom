// What the server advertises, and the seam extensions plug into (PST-REQ-070).
//
// Core capabilities are listed here with the state they appear in. An extension (PST-T-3.3:
// IDLE, CONDSTORE, QRESYNC, …) is an `ImapExtension` registered in extensions/index.ts: it adds
// capability names, may accept names in ENABLE, and may take over whole commands. The session
// consults the registry for all three, so adding an extension never edits the session.
import type { Command, CommandName, Response } from '@postroom/imap-proto';

export interface CapabilityState {
  /** TLS is up (implicit on 993, or after STARTTLS). */
  readonly secure: boolean;
  /** STARTTLS is possible (a certificate is configured and the connection is plaintext). */
  readonly startTlsAvailable: boolean;
  readonly authenticated: boolean;
}

/** Core IMAP4rev1 + IMAP4rev2 with the extensions rev2 folds in and the few we add. */
export function coreCapabilities(s: CapabilityState): string[] {
  const caps = ['IMAP4rev1', 'IMAP4rev2', 'LITERAL-', 'SASL-IR', 'ID', 'ENABLE'];
  if (!s.authenticated) {
    if (!s.secure) {
      if (s.startTlsAvailable) caps.push('STARTTLS');
      caps.push('LOGINDISABLED');
    } else {
      caps.push('AUTH=PLAIN');
    }
    return caps;
  }
  caps.push(
    'NAMESPACE',
    'UNSELECT',
    'UIDPLUS',
    'MOVE',
    'CHILDREN',
    'LIST-EXTENDED',
    'LIST-STATUS',
    'SPECIAL-USE',
    'ESEARCH',
    'SEARCHRES',
    'BINARY',
    'STATUS=SIZE',
    'UTF8=ACCEPT',
  );
  return caps;
}

/** What a command handler contributed by an extension can do with the session. */
export interface ExtensionSession {
  readonly accountId: string | null;
  readonly selectedMailboxId: string | null;
  readonly utf8: boolean;
  readonly enabled: ReadonlySet<string>;
  write(response: Response): Promise<void>;
  /** Bring the client up to date with its selected mailbox (EXISTS, EXPUNGE, FETCH FLAGS). */
  syncSelected(allowExpunge: boolean): Promise<void>;
  /** Read one raw line from the client (IDLE's DONE); null at end of stream. */
  readRawLine(timeoutMs: number): Promise<Buffer | null>;
}

export interface CommandOutcome {
  readonly status: 'OK' | 'NO' | 'BAD';
  readonly text: string;
}

export type ExtensionCommandHandler = (cmd: Command, session: ExtensionSession) => Promise<CommandOutcome>;

export interface ImapExtension {
  readonly name: string;
  /** Capability names this extension adds in the given state. */
  capabilities(state: CapabilityState): readonly string[];
  /** ENABLE names this extension accepts (e.g. CONDSTORE, QRESYNC). */
  readonly enables?: readonly string[];
  /** Commands this extension implements; they replace the core handler (and its state check). */
  readonly commands?: Partial<Record<CommandName, ExtensionCommandHandler>>;
}

export class CapabilityRegistry {
  constructor(readonly extensions: readonly ImapExtension[] = []) {}

  list(state: CapabilityState): string[] {
    const caps = coreCapabilities(state);
    for (const ext of this.extensions) {
      for (const c of ext.capabilities(state)) if (!caps.includes(c)) caps.push(c);
    }
    return caps;
  }

  /** Names ENABLE accepts: IMAP4rev2 and UTF8=ACCEPT from the core, plus the extensions'. */
  enableable(): Set<string> {
    const out = new Set(['IMAP4REV2', 'UTF8=ACCEPT']);
    for (const ext of this.extensions) for (const e of ext.enables ?? []) out.add(e.toUpperCase());
    return out;
  }

  handler(name: CommandName): ExtensionCommandHandler | undefined {
    for (const ext of this.extensions) {
      const h = ext.commands?.[name];
      if (h !== undefined) return h;
    }
    return undefined;
  }
}
