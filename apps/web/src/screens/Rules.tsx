import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Cluster,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Page,
  PageHeader,
  Section,
  Select,
  Skeleton,
  Stack,
  Table,
  TabPanel,
  Tabs,
  Textarea,
  type TableColumn,
} from '@d3cloud/ui';
import { ApiError, compileErrorOf, describeError, sieveApi, type SieveCompileError, type SieveScriptSummary } from '../api';

// ─── The builder's model, and its Sieve (PST-REQ-150) ────────────────────────────────────────────
//
// A rule is one row: "if <field> <contains|is> <value> then <action>". The builder writes Sieve in
// one fixed shape and reads back only that shape, so builder → Sieve → builder gives the same rows.
// Anything else (a script written by hand, or in Thunderbird) opens in the Sieve view instead.

export type RuleField = 'from' | 'to' | 'subject' | 'list-id';
export type RuleMatch = 'contains' | 'is';
export type RuleAction = 'move' | 'bucket' | 'flag' | 'read';

export interface Rule {
  field: RuleField;
  match: RuleMatch;
  value: string;
  action: RuleAction;
  /** The folder (move) or bucket (bucket); '' for flag and read. */
  target: string;
}

export const BUILDER_SCRIPT = 'Postroom rules';

export const FIELDS: { value: RuleField; label: string }[] = [
  { value: 'from', label: 'From' },
  { value: 'to', label: 'To' },
  { value: 'subject', label: 'Subject' },
  { value: 'list-id', label: 'List-Id' },
];

export const MATCHES: { value: RuleMatch; label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'is', label: 'is' },
];

export const ACTIONS: { value: RuleAction; label: string }[] = [
  { value: 'move', label: 'Move to folder' },
  { value: 'bucket', label: 'Sort into bucket' },
  { value: 'flag', label: 'Flag it' },
  { value: 'read', label: 'Mark as read' },
];

export const BUCKETS: { value: string; label: string }[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'people', label: 'People' },
  { value: 'newsletters', label: 'Newsletters' },
  { value: 'updates', label: 'Updates' },
  { value: 'receipts', label: 'Receipts' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'junk', label: 'Junk' },
];

const HEADER = '# Postroom rules: written by the webmail rules builder. Rules run from top to bottom.';
const ADDRESS_FIELDS: ReadonlySet<RuleField> = new Set(['from', 'to']);

/** A Sieve quoted string: only " and \ are escaped (RFC 5228 §2.4.2). */
export function sieveString(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function actionLine(rule: Rule): string {
  switch (rule.action) {
    case 'move':
      return `fileinto :create ${sieveString(rule.target)};`;
    case 'bucket':
      return `bucket ${sieveString(rule.target)};`;
    case 'flag':
      return 'addflag "\\\\Flagged";';
    case 'read':
      return 'addflag "\\\\Seen";';
  }
}

/** The rows as Sieve, in the one shape `sieveToRules` reads back. */
export function rulesToSieve(rules: readonly Rule[]): string {
  const needs = new Set<string>();
  for (const r of rules) {
    if (r.action === 'move') {
      needs.add('fileinto');
      needs.add('mailbox');
    }
    if (r.action === 'bucket') needs.add('vnd.postroom.bucket');
    if (r.action === 'flag' || r.action === 'read') needs.add('imap4flags');
  }
  const order = ['fileinto', 'mailbox', 'imap4flags', 'vnd.postroom.bucket'].filter((c) => needs.has(c));
  const lines = [HEADER];
  if (order.length > 0) lines.push(`require [${order.map(sieveString).join(', ')}];`);
  for (const r of rules) {
    const test = ADDRESS_FIELDS.has(r.field) ? 'address' : 'header';
    lines.push('', `if ${test} :${r.match} ${sieveString(r.field)} ${sieveString(r.value)} {`, `  ${actionLine(r)}`, '}');
  }
  return `${lines.join('\n')}\n`;
}

const STRING = String.raw`"((?:[^"\\]|\\.)*)"`;
const IF_LINE = new RegExp(String.raw`^if (address|header) :(contains|is) ${STRING} ${STRING} \{$`);
const MOVE_LINE = new RegExp(String.raw`^fileinto :create ${STRING};$`);
const BUCKET_LINE = new RegExp(String.raw`^bucket ${STRING};$`);
const REQUIRE_LINE = /^require \[("[a-z0-9.;-]+"(, "[a-z0-9.;-]+")*)\];$/;

function unquote(escaped: string): string {
  return escaped.replace(/\\(.)/g, '$1');
}

function isField(value: string): value is RuleField {
  return FIELDS.some((f) => f.value === value);
}

/**
 * Sieve → rows, for the builder's own shape only. Null for anything else: a script written by hand
 * (or by another client) is edited as Sieve, never half-read into rows.
 */
export function sieveToRules(source: string): Rule[] | null {
  const lines = source.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());
  const rules: Rule[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line === '' || line.startsWith('#') || REQUIRE_LINE.test(line)) {
      i++;
      continue;
    }
    const cond = IF_LINE.exec(line);
    if (cond === null) return null;
    const [, test = '', match = '', rawField = '', rawValue = ''] = cond;
    const field = unquote(rawField);
    if (!isField(field) || (test === 'address') !== ADDRESS_FIELDS.has(field)) return null;
    const body = lines[i + 1] ?? '';
    if (lines[i + 2] !== '}') return null;
    let action: RuleAction;
    let target = '';
    const move = MOVE_LINE.exec(body);
    const bucket = BUCKET_LINE.exec(body);
    if (move !== null) {
      action = 'move';
      target = unquote(move[1] ?? '');
    } else if (bucket !== null) {
      action = 'bucket';
      target = unquote(bucket[1] ?? '');
    } else if (body === 'addflag "\\\\Flagged";') {
      action = 'flag';
    } else if (body === 'addflag "\\\\Seen";') {
      action = 'read';
    } else {
      return null;
    }
    rules.push({ field, match: match as RuleMatch, value: unquote(rawValue), action, target });
    i += 3;
  }
  return rules;
}

/** Why a row cannot be saved yet, or null. */
export function ruleProblem(rule: Rule): string | null {
  if (rule.value.trim() === '') return 'Say what to look for.';
  if (/[\r\n]/.test(rule.value)) return 'What to look for must be on one line.';
  if (rule.action === 'move' && rule.target.trim() === '') return 'Name the folder to move it to.';
  if (rule.action === 'bucket' && !BUCKETS.some((b) => b.value === rule.target)) return 'Choose a bucket.';
  return null;
}

export const newRule = (): Rule => ({ field: 'from', match: 'contains', value: '', action: 'move', target: '' });

/** "Line 4, column 1: expected …" with the message's own position prefix removed. */
export function describeCompileError(e: SieveCompileError): { title: string; detail: string } {
  return { title: `Line ${String(e.line)}, column ${String(e.column)}`, detail: e.message.replace(/^line \d+, column \d+: /, '') };
}

// ─── The screen ──────────────────────────────────────────────────────────────────────────────────

type Mode = 'builder' | 'sieve';

function RuleRow({ rule, index, onChange, onRemove }: { rule: Rule; index: number; onChange: (next: Rule) => void; onRemove: () => void }) {
  const n = String(index + 1);
  return (
    <Section title={`Rule ${n}`} headingLevel={3} actions={<Button variant="danger-ghost" size="sm" onClick={onRemove}>Remove rule {n}</Button>}>
      <Cluster gap="12" align="end">
        <FormField label="When">
          <Select
            options={FIELDS}
            value={rule.field}
            onValueChange={(v) => {
              onChange({ ...rule, field: v as RuleField });
            }}
          />
        </FormField>
        <FormField label="Match">
          <Select
            options={MATCHES}
            value={rule.match}
            onValueChange={(v) => {
              onChange({ ...rule, match: v as RuleMatch });
            }}
          />
        </FormField>
        <FormField label="Text">
          <Input
            value={rule.value}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              onChange({ ...rule, value: e.target.value });
            }}
          />
        </FormField>
        <FormField label="Then">
          <Select
            options={ACTIONS}
            value={rule.action}
            onValueChange={(v) => {
              const action = v as RuleAction;
              onChange({ ...rule, action, target: action === 'bucket' ? 'newsletters' : action === 'move' ? rule.target : '' });
            }}
          />
        </FormField>
        {rule.action === 'move' ? (
          <FormField label="Folder">
            <Input
              value={rule.target}
              autoComplete="off"
              onChange={(e) => {
                onChange({ ...rule, target: e.target.value });
              }}
            />
          </FormField>
        ) : null}
        {rule.action === 'bucket' ? (
          <FormField label="Bucket">
            <Select
              options={BUCKETS}
              value={rule.target}
              onValueChange={(v) => {
                onChange({ ...rule, target: v });
              }}
            />
          </FormField>
        ) : null}
      </Cluster>
    </Section>
  );
}

/**
 * Rules (PST-REQ-150): simple rows that compile to Sieve, an "edit as Sieve" view, and compile
 * errors with their line numbers. The same scripts Thunderbird edits over ManageSieve; the active
 * one runs on every new message.
 */
export function Rules() {
  const [scripts, setScripts] = useState<SieveScriptSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState(BUILDER_SCRIPT);
  const [mode, setMode] = useState<Mode>('builder');
  const [rules, setRules] = useState<Rule[]>([]);
  const [source, setSource] = useState('');
  const [handWritten, setHandWritten] = useState(false);
  const [compileError, setCompileError] = useState<SieveCompileError | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useCallback(async (scriptName: string) => {
    setCompileError(null);
    setFormError(null);
    setName(scriptName);
    let content = '';
    try {
      content = (await sieveApi.get(scriptName)).content;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    const parsed = sieveToRules(content);
    setSource(content);
    setHandWritten(parsed === null);
    setRules(parsed ?? []);
    setMode(parsed === null ? 'sieve' : 'builder');
  }, []);

  const load = useCallback(async () => {
    try {
      const list = (await sieveApi.list()).scripts;
      setScripts(list);
      setLoadError(false);
      return list;
    } catch {
      setLoadError(true);
      return null;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const list = await load();
      if (list === null) return;
      const first = list.find((s) => s.active) ?? list.find((s) => s.name === BUILDER_SCRIPT);
      try {
        await open(first?.name ?? BUILDER_SCRIPT);
      } catch {
        setLoadError(true);
      }
    })();
  }, [load, open]);

  const current = scripts?.find((s) => s.name === name) ?? null;
  const text = (): string => (mode === 'builder' ? rulesToSieve(rules) : source);

  const switchMode = (next: string) => {
    setCompileError(null);
    if (next === 'sieve' && mode === 'builder') {
      setSource(rulesToSieve(rules));
      setMode('sieve');
      return;
    }
    if (next === 'builder' && mode === 'sieve') {
      const parsed = sieveToRules(source);
      if (parsed === null) {
        setHandWritten(true);
        setNotice('This script is not in the shape the builder writes, so it stays in the Sieve view.');
        return;
      }
      setHandWritten(false);
      setRules(parsed);
      setMode('builder');
    }
  };

  const validRows = (): boolean => {
    if (mode !== 'builder') return true;
    const bad = rules.findIndex((r) => ruleProblem(r) !== null);
    if (bad < 0) return true;
    setFormError(`Rule ${String(bad + 1)}: ${ruleProblem(rules[bad] as Rule) ?? ''}`);
    return false;
  };

  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    setFormError(null);
    setCompileError(null);
    work()
      .catch((error: unknown) => {
        const problem = compileErrorOf(error);
        if (problem !== null) setCompileError(problem);
        else setFormError(describeError(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const check = () => {
    if (!validRows()) return;
    run(async () => {
      const result = await sieveApi.check(text());
      if (result.error !== null) setCompileError(result.error);
      else setNotice('The script is valid.');
    });
  };

  const save = (activate: boolean) => (event?: SyntheticEvent) => {
    event?.preventDefault();
    if (!validRows()) return;
    run(async () => {
      const content = text();
      await sieveApi.put(name, content);
      if (activate) await sieveApi.activate(name);
      if (mode === 'builder') setSource(content);
      await load();
      setNotice(activate ? `Saved. "${name}" now runs on new mail.` : `Saved "${name}".`);
    });
  };

  const turnOff = () => {
    run(async () => {
      await sieveApi.deactivate();
      await load();
      setNotice('No rules run now; new mail is sorted by Postroom alone.');
    });
  };

  const remove = (target: string) => {
    run(async () => {
      await sieveApi.remove(target);
      const list = await load();
      if (target === name) await open(list?.find((s) => s.active)?.name ?? BUILDER_SCRIPT);
      setNotice(`Deleted "${target}".`);
    });
  };

  const errorLine = compileError === null ? null : (text().split(/\r\n|\r|\n/)[compileError.line - 1] ?? null);

  const columns: TableColumn<SieveScriptSummary>[] = [
    { key: 'name', header: 'Script', cell: (s) => s.name },
    { key: 'active', header: 'State', cell: (s) => (s.active ? <Badge size="sm">Running</Badge> : null) },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (s) => (
        <Cluster gap="8" justify="end">
          <Button
            size="sm"
            variant="ghost"
            disabled={s.name === name}
            onClick={() => {
              run(() => open(s.name));
            }}
          >
            Edit {s.name}
          </Button>
          {s.active ? null : (
            <Button
              size="sm"
              variant="danger-ghost"
              onClick={() => {
                remove(s.name);
              }}
            >
              Delete {s.name}
            </Button>
          )}
        </Cluster>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Rules"
        description="Sort, flag or file new mail as it arrives. The rules are a Sieve script — the same ones a Sieve client like Thunderbird edits."
      />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      {loadError ? (
        <EmptyState kind="error" heading="Could not load your rules" headingLevel={2} action={<Button onClick={() => void load()}>Try again</Button>}>
          The server did not answer.
        </EmptyState>
      ) : scripts === null ? (
        <Skeleton variant="block" />
      ) : (
        <Stack gap="24">
          <Section
            title={`Editing "${name}"`}
            description={current?.active === true ? 'This script runs on every new message.' : 'This script is not running. Save and turn it on to use it.'}
          >
            <form onSubmit={save(false)} noValidate>
              <Stack gap="16">
                <Tabs
                  aria-label="How to edit"
                  items={[
                    { value: 'builder', label: 'Rules', disabled: handWritten },
                    { value: 'sieve', label: 'Edit as Sieve' },
                  ]}
                  value={mode}
                  onValueChange={switchMode}
                >
                  <TabPanel value="builder">
                    <Stack gap="16">
                      {rules.length === 0 ? (
                        <EmptyState kind="empty" heading="No rules yet" headingLevel={3}>
                          Add a rule to move, sort, flag or mark mail as read when it arrives.
                        </EmptyState>
                      ) : (
                        rules.map((rule, i) => (
                          <RuleRow
                            key={i}
                            rule={rule}
                            index={i}
                            onChange={(next) => {
                              setRules((all) => all.map((r, j) => (j === i ? next : r)));
                            }}
                            onRemove={() => {
                              setRules((all) => all.filter((_, j) => j !== i));
                            }}
                          />
                        ))
                      )}
                      <Cluster>
                        <Button
                          onClick={() => {
                            setRules((all) => [...all, newRule()]);
                          }}
                        >
                          Add rule
                        </Button>
                      </Cluster>
                    </Stack>
                  </TabPanel>
                  <TabPanel value="sieve">
                    <FormField
                      label="Sieve script"
                      help={handWritten ? 'Written by hand or in another client, so it is edited here as Sieve.' : 'Switch back to Rules to edit rows again.'}
                    >
                      <Textarea
                        mono
                        rows={16}
                        spellCheck={false}
                        value={source}
                        invalid={compileError !== null}
                        onChange={(e) => {
                          setSource(e.target.value);
                        }}
                      />
                    </FormField>
                  </TabPanel>
                </Tabs>

                {compileError === null ? null : (
                  <Alert tone="danger" dynamic title={`The script does not compile — ${describeCompileError(compileError).title}`}>
                    <Stack gap="8">
                      <span>{describeCompileError(compileError).detail}</span>
                      {errorLine === null ? null : (
                        <code>
                          {String(compileError.line)}: {errorLine}
                        </code>
                      )}
                    </Stack>
                  </Alert>
                )}
                {formError === null ? null : (
                  <Alert tone="danger" dynamic>
                    {formError}
                  </Alert>
                )}

                <FormActions>
                  <Button onClick={check} disabled={busy}>
                    Check
                  </Button>
                  <Button type="submit" disabled={busy}>
                    Save
                  </Button>
                  <Button variant="primary" loading={busy} onClick={() => {
                      save(true)();
                    }}>
                    Save and turn on
                  </Button>
                </FormActions>
              </Stack>
            </form>
          </Section>

          <Section
            title="Scripts"
            description="One script runs at a time."
            actions={
              scripts.some((s) => s.active) ? (
                <Button variant="ghost" size="sm" onClick={turnOff} disabled={busy}>
                  Turn rules off
                </Button>
              ) : undefined
            }
          >
            {scripts.length === 0 ? (
              <EmptyState kind="empty" heading="No scripts saved yet" headingLevel={3}>
                Save your rules to create one.
              </EmptyState>
            ) : (
              <Table caption="Scripts" captionHidden columns={columns} rows={scripts} rowKey={(s) => s.name} />
            )}
          </Section>
        </Stack>
      )}
    </Page>
  );
}
