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

// PST-T-17.11 (PST-REQ-194, PST-REQ-155): Rules & sorting on the canvas.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODES } from '../../src/screens/Rules';
import { createRunGuard, runningState, scriptActions, showsScripts } from '../../src/screens/rules/scripts';
import { correctionLine, correctionTitle, undoneMessage } from '../../src/screens/rules/Corrections';

const script = (name: string, active = false) => ({ name, active, size: 10, updatedAt: '2026-10-01T00:00:00Z' });
const source = (path: string): string => readFileSync(join(__dirname, '../../src', path), 'utf8');

describe('the Rules & sorting page (PST-T-17.11)', () => {
  it('offers Edit unless the script is open, Delete unless it runs — one action a button, two behind ⋯', () => {
    expect(scriptActions(script('Postroom rules', true), 'Postroom rules')).toEqual([]);
    expect(scriptActions(script('Postroom rules'), 'Postroom rules')).toEqual(['delete']);
    expect(scriptActions(script('Thunderbird', true), 'Postroom rules')).toEqual(['edit']);
    expect(scriptActions(script('Thunderbird'), 'Postroom rules')).toEqual(['edit', 'delete']);
  });

  it('shows the Scripts card only when a script other than the open one exists', () => {
    expect(showsScripts([], 'Postroom rules')).toBe(false);
    expect(showsScripts([script('Postroom rules', true)], 'Postroom rules')).toBe(false);
    expect(showsScripts([script('Postroom rules'), script('Thunderbird')], 'Postroom rules')).toBe(true);
    // A lone script that is not the one open (the builder's, unsaved) is still listed.
    expect(showsScripts([script('Thunderbird')], 'Postroom rules')).toBe(true);
  });

  it('says Running neutrally and Not running as idle (D-016: no success colour)', () => {
    expect(runningState(script('a', true))).toEqual({ tone: 'neutral', label: 'Running' });
    expect(runningState(script('a'))).toEqual({ tone: 'idle', label: 'Not running' });
    expect(runningState(null)).toEqual({ tone: 'idle', label: 'Not running' });
  });

  it('switches Rules / Edit as Sieve, with Rules unavailable for a hand-written script', () => {
    expect(MODES(false).map((m) => [m.label, m.disabled ?? false])).toEqual([['Rules', false], ['Edit as Sieve', false]]);
    expect(MODES(true)[0]?.disabled).toBe(true);
  });

  it('puts a correction on one line: where it went, who sent it, and where you corrected it', () => {
    const c = { moved: true, fromBucket: 'people', toBucket: 'updates', target: 'pat@example.net', scope: 'sender' as const, subject: 'Hi', fromAddress: 'pat@example.net', source: 'chip' as const };
    expect(correctionLine(c)).toBe('People → Updates · pat@example.net · from the bucket chip');
    expect(correctionLine({ ...c, moved: false, source: 'card' })).toBe('Kept in Updates · pat@example.net · from the Person card');
    // No sender on record: the line still says where it went and where it was corrected.
    expect(correctionLine({ ...c, fromAddress: null })).toBe('People → Updates · from the bucket chip');
    // A domain preference says how far it reaches.
    expect(correctionLine({ ...c, target: '@example.net', scope: 'domain' })).toBe('People → Updates · pat@example.net · from the bucket chip · learned for example.net (the whole domain)');
    expect(correctionTitle(c)).toBe('Hi');
    expect(correctionTitle({ ...c, subject: null, target: '@example.net', scope: 'domain' })).toBe('(no subject) · example.net (the whole domain)');
    expect(undoneMessage(c, { preferenceRestored: true, movedBack: true })).toBe('Undone: pat@example.net is sorted as before; the message is back in People.');
    expect(undoneMessage({ ...c, moved: false }, { preferenceRestored: false, movedBack: false })).toBe('Undone: a later choice for pat@example.net was kept.');
  });

  it('runs one write at a time: a second run while one is in flight never starts', async () => {
    const guard = createRunGuard();
    let release: () => void = () => undefined;
    const first = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const second = vi.fn(() => Promise.resolve());
    const running = guard.run(first);
    expect(running).not.toBeNull();
    expect(guard.running).toBe(true);
    // Save without turning on, Turn rules off, Enter — all refused while the first (or its step-up) waits.
    expect(guard.run(second)).toBeNull();
    expect(guard.run(second)).toBeNull();
    expect(second).not.toHaveBeenCalled();
    release();
    await running;
    expect(guard.running).toBe(false);
    await guard.run(second);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('releases the guard when a write fails, even one that throws before its first await', async () => {
    const guard = createRunGuard();
    await expect(guard.run(() => Promise.reject(new Error('409')))).rejects.toThrow('409');
    expect(guard.running).toBe(false);
    await expect(guard.run(() => { throw new Error('sync'); })).rejects.toThrow('sync');
    expect(guard.running).toBe(false);
    const ok = vi.fn(() => Promise.resolve());
    await guard.run(ok);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('wires the guard and the busy state into every way to write', () => {
    const rules = source('screens/Rules.tsx');
    // run() goes through the guard; save and check bail out while one is running.
    expect(rules).toMatch(/const run = \(work: \(\) => Promise<void>\) => \{\s*(\/\/[^\n]*\n\s*)*void guard\.run\(/);
    expect(rules).toMatch(/const save = [\s\S]*?if \(guard\.running \|\| !validRows\(\)\) return;/);
    // The SplitButton is the form's submit, disabled (both halves) while busy, and Enter saves the same way.
    const split = rules.slice(rules.indexOf('<SplitButton'), rules.indexOf('</SplitButton>'));
    expect(split).toContain('type="submit"');
    expect(split).toContain('disabled={busy}');
    expect(split).not.toContain('onClick');
    expect(rules).toContain('<form onSubmit={save(true)} noValidate>');
    // Delete: the confirm closes only once the delete went through or failed — a cancelled step-up keeps it.
    const remove = rules.slice(rules.indexOf('const remove = '), rules.indexOf('const errorLine'));
    expect(remove.indexOf('withStepUp(() => sieveApi.remove(target))')).toBeLessThan(remove.indexOf('setConfirming(null);'));
    expect(remove).toMatch(/=== null\) return;/);
  });

  it('is the canvas: titled as the nav, centred, the editor first, one action row, no page-size empty state', () => {
    const rules = source('screens/Rules.tsx');
    expect(rules).toContain('<PageHeader title="Rules & sorting"');
    expect(rules).toContain('<Page width="narrow" align="center">');
    // The editor card, then Scripts, then the corrections log.
    const editor = rules.indexOf('title="Your rules"');
    expect(editor).toBeGreaterThan(0);
    expect(rules.indexOf('title="Scripts"')).toBeGreaterThan(editor);
    expect(rules.indexOf('<Corrections />')).toBeGreaterThan(rules.indexOf('title="Scripts"'));
    // The mode switch sits in the card head; no Tabs between the title and the content.
    expect(rules).toMatch(/actions=\{\s*<div className="pr-rules__head">[\s\S]*<SegmentedControl size="sm"/);
    expect(rules).not.toMatch(/<Tabs\b/);
    // One action row: Check syntax leading, one SplitButton with the other save in its menu.
    expect(rules).toMatch(/<FormActions\s+className="pr-setform__actions"\s+leading=\{\s*<Button variant="ghost"/);
    expect(rules).toContain('label="Save and turn on"');
    expect(rules).toMatch(/<MenuItem[\s\S]*?Save without turning on/);
    // Never red in a row: no danger-ghost; the destructive styling lives in the confirm Modal.
    expect(rules).not.toContain('danger-ghost');
    // Every write can be stepped up in "Confirm it is you".
    expect(rules).toContain("useStepUp('Changing your rules changes where new mail goes')");
    for (const write of ['sieveApi.put', 'sieveApi.deactivate()', 'sieveApi.remove(target)']) {
      const at = rules.indexOf(write);
      expect(rules.lastIndexOf('withStepUp(', at), write).toBeGreaterThan(rules.lastIndexOf('run(async', at));
    }
  });

  it('renders every empty state inside its card at row size (X7)', () => {
    for (const file of ['screens/Rules.tsx', 'screens/rules/Corrections.tsx']) {
      const text = source(file);
      const states = [...text.matchAll(/<EmptyState\b([^>]*)/g)];
      expect(states.length, file).toBeGreaterThan(0);
      for (const m of states) expect(m[1], file).toMatch(/size="(row|inline)"/);
    }
  });
});
