// PST-T-9.5 / PST-REQ-150: the rules builder round-trips — rows → Sieve → the same rows — and the
// Sieve it writes compiles with Postroom's own interpreter. A script in any other shape is not
// half-read into rows; it opens in the Sieve view.
import { describe, expect, it, vi } from 'vitest';
import { compileErrorOf, ApiError } from '../../src/api';
// The interpreter the worker runs, from source (the web app does not ship it).
import { compileScript, SieveSyntaxError } from '../../../../packages/sieve/src/index';

// The component library ships CSS, which Node cannot import; nothing here renders.
vi.mock('@d3cloud/ui', () => ({}));
import { applyDestination, destinationOptions, destinationValue, isGroupHeader } from '../../src/screens/rules/destinations';
import type { Mailbox } from '../../src/api';
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
    expect(ruleProblem({ ...newRule(), value: 'x' })).toBe('Choose where to move it.');
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

// PST-T-16.9: one destination picker of real mailboxes and buckets.
const box = (name: string, specialUse: Mailbox['specialUse'] = null): Mailbox => ({
  id: name,
  name,
  specialUse,
  uidvalidity: 1,
  uidnext: 1,
  highestModseq: '1',
  subscribed: true,
  total: 0,
  unseen: 0,
});
const MAILBOXES: Mailbox[] = [
  box('INBOX', 'inbox'),
  box('Sent', 'sent'),
  box('Drafts', 'drafts'),
  box('Trash', 'trash'),
  box('Junk', 'junk'),
  box('Archive', 'archive'),
  box('Rejects', 'rejects'),
  box('Newsletters'),
  box('Updates'),
  box('Receipts'),
  box('Notifications'),
  box('Projects'),
  box('Family'),
];
const draft = { action: 'move', target: '' };

describe('the rule destination picker (PST-T-16.9)', () => {
  it('lists the mailboxes, the Sorted for you buckets, then your folders — grouped like the sidebar', () => {
    const options = destinationOptions(MAILBOXES, draft);
    expect(options.map((o) => (isGroupHeader(o.value) ? `# ${o.label}` : o.label))).toEqual([
      '# Mailboxes', 'Inbox', 'Inbox · Priority', 'Inbox · People', 'Archive', 'Junk', 'Trash',
      '# Sorted for you', 'Updates', 'Receipts', 'Notifications', 'Newsletters',
      '# Your folders', 'Family', 'Projects',
    ]);
    expect(options.filter((o) => isGroupHeader(o.value)).every((o) => o.disabled === true)).toBe(true);
    // Never Sent, Drafts or Rejects, and a bucket folder is offered once, as a bucket.
    expect(options.map((o) => o.label)).not.toContain('Sent');
    expect(options.map((o) => o.label).filter((l) => l === 'Receipts')).toHaveLength(1);
  });

  it('compiles a folder choice as move to folder and a bucket choice as sort into bucket, unchanged', () => {
    const folder = applyDestination({ ...newRule(), value: 'x' }, 'folder:Projects');
    expect(folder).toMatchObject({ action: 'move', target: 'Projects' });
    expect(rulesToSieve([folder])).toContain('fileinto :create "Projects";');
    const bucket = applyDestination({ ...newRule(), value: 'x' }, 'bucket:receipts');
    expect(bucket).toMatchObject({ action: 'bucket', target: 'receipts' });
    expect(rulesToSieve([bucket])).toContain('bucket "receipts";');
    expect(rulesToSieve([bucket])).toContain('require ["vnd.postroom.bucket"];');
    // A heading chooses nothing.
    expect(applyDestination(folder, 'group:sorted')).toBe(folder);
  });

  it('selects the right option for a saved rule of either kind', () => {
    const [moved, bucketed] = sieveToRules(rulesToSieve([ALL[0] as Rule, ALL[1] as Rule])) as Rule[];
    expect(destinationValue(bucketed as Rule)).toBe('bucket:newsletters');
    expect(destinationOptions(MAILBOXES, bucketed as Rule).some((o) => o.value === 'bucket:newsletters')).toBe(true);
    // A saved move to a bucket folder is a folder choice: kept, and told apart from the bucket.
    expect(destinationValue(moved as Rule)).toBe('folder:Receipts');
    const kept = destinationOptions(MAILBOXES, moved as Rule).find((o) => o.value === 'folder:Receipts');
    expect(kept?.label).toBe('Receipts (folder only)');
    expect(destinationValue({ action: 'flag', target: '' })).toBe('');
    expect(destinationValue(draft)).toBe('');
  });

  it('keeps a saved destination that no longer exists, as missing', () => {
    const gone = { action: 'move', target: 'Old project' };
    const kept = destinationOptions(MAILBOXES, gone).find((o) => o.value === 'folder:Old project');
    expect(kept?.label).toBe('Old project (missing)');
    expect(destinationOptions(MAILBOXES, { action: 'bucket', target: 'junk' }).find((o) => o.value === 'bucket:junk')?.label).toBe('Junk bucket');
    // Before the list loads, the saved folder shows as itself, not as missing.
    expect(destinationOptions(null, gone).find((o) => o.value === 'folder:Old project')?.label).toBe('Old project');
  });
});
