// Sieve (RFC 5228) parser and interpreter with the chosen extensions (PST-REQ-148): fileinto,
// envelope, imap4flags, variables, body, vacation, mailbox (:create) and vnd.postroom.bucket.
//
//   const script = compileScript(source);            // SieveSyntaxError on any compile-time error
//   const result = execute(script, message, options); // never throws for script or message content
//
// Hand-rolled: lexer, parser, validator and interpreter are all here; see README.md.
import type { ScriptNode } from './ast.js';
import { compile, type CompiledScript } from './compile.js';
import { parse, type ParseLimits } from './parser.js';

export const PACKAGE = '@postroom/sieve';

export { SieveSyntaxError, SieveRuntimeError, isSieveError, type SourcePos, type SyntaxErrorCode, type RuntimeErrorCode } from './errors.js';
export type { Argument, CommandNode, TestNode, ScriptNode } from './ast.js';
export { Lexer, type Token, type TokenKind } from './lexer.js';
export { parse, resolveLimits, DEFAULT_LIMITS, type ParseLimits } from './parser.js';
export { print, quote } from './printer.js';
export {
  compile,
  isAddress,
  SUPPORTED_EXTENSIONS,
  type CompiledScript,
  type CompiledCommand,
  type CompiledTest,
  type MatchSpec,
  type AddressPart,
  type BodyTransform,
  type SetModifier,
} from './compile.js';
export { globMatch, matchOne, foldAscii, type Comparator, type MatchType, type Budget } from './match.js';
export { messageFromMime, type SieveMessage, type SieveEnvelope, type SieveBodyPart, type FromMimeOptions } from './message.js';
export {
  execute,
  type ExecuteOptions,
  type SieveResult,
  type SieveAction,
  type KeepAction,
  type FileintoAction,
  type DiscardAction,
  type RedirectAction,
  type VacationAction,
  type VacationStore,
  type TraceEntry,
} from './interpreter.js';

/** Parse and validate in one step — what ManageSieve's PUTSCRIPT/CHECKSCRIPT need. */
export function compileScript(source: string | Uint8Array, limits: ParseLimits = {}): CompiledScript {
  const ast: ScriptNode = parse(source, limits);
  return compile(ast);
}
