// PST-T-9.5 / PST-REQ-150: the rules builder round-trips — rows → Sieve → the same rows — and the
// Sieve it writes compiles with Postroom's own interpreter. A script in any other shape is not
// half-read into rows; it opens in the Sieve view.
import { describe, expect, it, vi } from 'vitest';
import { compileErrorOf, ApiError } from '../../src/api';
// The interpreter the worker runs, from source (the web app does not ship it).
import { compileScript, SieveSyntaxError } from '../../../../packages/sieve/src/index';

// The component library ships CSS, which Node cannot import; nothing here renders.
vi.mock('@d3cloud/ui', () => ({}));
import { describeCompileError, newRule, ruleProblem, rulesToSieve, sieveString, sieveToRules, type Rule } from '../../src/screens/Rules';

const ALL: Rule[] = [
  { field: 'from', match: 'contains', value: 'billing@shop.example', action: 'move', target: 'Receipts' },
  { field: 'subject', match: 'is', value: 'Your "weekly" digest \\ news', action: 'bucket', target: 'newsletters' },
  { field: 'list-id', match: 'contains', value: 'announce.lists.example.org', action: 'read', target: '' },
  { field: 'to', match: 'is', value: 'me+github@d3cloud.io', action: 'flag', target: '' },
  { field: 'subject', match: 'contains', value: 'Ünïcødé ✓', action: 'move', target: 'Projects/Ärger' },
];

describe('the rules builder (PST-REQ-150)', () => {
  it('round-trips every field, match and action through Sieve', () => {
    const sieve = rulesToSieve(ALL);
    expect(sieveToRules(sieve)).toEqual(ALL);
    // One rule at a time, too: the require line changes with the actions used.
    for (const rule of ALL) expect(sieveToRules(rulesToSieve([rule]))).toEqual([rule]);
    expect(sieveToRules(rulesToSieve([]))).toEqual([]);
  });

  it('writes Sieve that Postroom compiles, requiring exactly what it uses', () => {
    const sieve = rulesToSieve(ALL);
    expect(() => compileScript(sieve)).not.toThrow();
    expect(sieve).toContain('require ["fileinto", "mailbox", "imap4flags", "vnd.postroom.bucket"];');
    expect(sieve).toContain('if address :contains "from" "billing@shop.example" {\n  fileinto :create "Receipts";\n}');
    expect(sieve).toContain('if header :is "subject" "Your \\"weekly\\" digest \\\\ news" {\n  bucket "newsletters";\n}');
    expect(sieve).toContain('addflag "\\\\Seen";');
    expect(sieve).toContain('addflag "\\\\Flagged";');
    const moveOnly = rulesToSieve([ALL[0] as Rule]);
    expect(moveOnly).toContain('require ["fileinto", "mailbox"];');
    expect(() => compileScript(moveOnly)).not.toThrow();
    expect(() => compileScript(rulesToSieve([]))).not.toThrow();
  });

  it('reads back CRLF line endings (as ManageSieve clients send them)', () => {
    expect(sieveToRules(rulesToSieve(ALL).replace(/\n/g, '\r\n'))).toEqual(ALL);
  });

  it('refuses anything not in its own shape, so a hand-written script opens as Sieve', () => {
    expect(sieveToRules('require "fileinto";\nif header :contains "subject" "x" { fileinto "A"; }\n')).toBeNull();
    expect(sieveToRules('if header :contains "subject" "x" {\n  fileinto :create "A";\n  stop;\n}\n')).toBeNull();
    expect(sieveToRules('if address :contains "subject" "x" {\n  fileinto :create "A";\n}\n')).toBeNull();
    expect(sieveToRules('if header :contains "x-spam" "yes" {\n  fileinto :create "A";\n}\n')).toBeNull();
    expect(sieveToRules('require "vacation";\nvacation "away";\n')).toBeNull();
    expect(sieveToRules('keep;\n')).toBeNull();
  });

  it('quotes only " and \\ in Sieve strings', () => {
    expect(sieveString('plain')).toBe('"plain"');
    expect(sieveString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('says what is missing from a row before it is saved', () => {
    expect(ruleProblem(newRule())).toBe('Say what to look for.');
    expect(ruleProblem({ ...newRule(), value: 'x' })).toBe('Name the folder to move it to.');
    expect(ruleProblem({ ...newRule(), value: 'x', action: 'bucket', target: 'nope' })).toBe('Choose a bucket.');
    expect(ruleProblem({ ...newRule(), value: 'x', action: 'read' })).toBeNull();
  });

  it('shows a compile error by its line and column', () => {
    let caught: unknown = null;
    try {
      compileScript('require "fileinto";\n\nfileinto "Receipts"\nkeep;\n');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SieveSyntaxError);
    const e = caught as SieveSyntaxError;
    const shown = describeCompileError({ line: e.line, column: e.column, message: e.message });
    expect(shown.title).toBe('Line 4, column 1');
    expect(shown.detail).not.toMatch(/^line /);
    const refused = new ApiError(422, 'invalid_script', { error: 'invalid_script', message: e.message, compileError: { line: 4, column: 1, message: e.message } });
    expect(compileErrorOf(refused)).toEqual({ line: 4, column: 1, message: e.message });
    expect(compileErrorOf(new ApiError(409, 'script_active', {}))).toBeNull();
  });
});
