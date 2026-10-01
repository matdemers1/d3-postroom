import '../settings/settings.css';
import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Cluster,
  DataList,
  DataListRow,
  EmptyState,
  FormActions,
  FormField,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  Section,
  SegmentedControl,
  Select,
  SplitButton,
  Stack,
  StatusDot,
  Textarea,
} from '@d3cloud/ui';
import { ApiError, compileErrorOf, describeError, sieveApi, type Mailbox, type SieveCompileError, type SieveScriptSummary } from '../api';
import { useStepUp } from '../admin/sign-in/step-up';
import { MoreIcon } from '../mail/thread/icons';
import { Loading, LoadFailed } from './states';
import { Corrections } from './rules/Corrections';
import { applyDestination, BUCKETS, destinationOptions, destinationValue } from './rules/destinations';
import { PlusIcon } from './rules/icons';
import { createRunGuard, runningState, scriptActions, showsScripts } from './rules/scripts';
import { useMailboxes } from './rules/useMailboxes';

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
  // PST-T-16.9: a folder and a bucket are both "move it to", chosen in one destination picker.
  { value: 'move', label: 'Move it to' },
  { value: 'flag', label: 'Flag it' },
  { value: 'read', label: 'Mark as read' },
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
  if (rule.action === 'move' && rule.target.trim() === '') return 'Choose where to move it.';
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

/** The editor's two views of one script: a SegmentedControl in the card head, not Tabs between the
 *  title and the content (critique-settings 2.6 #5). */
export const MODES = (handWritten: boolean) => [
  { value: 'builder', label: 'Rules', disabled: handWritten },
  { value: 'sieve', label: 'Edit as Sieve' },
];

function RuleRow({ rule, index, mailboxes, onChange, onRemove }: { rule: Rule; index: number; mailboxes: Mailbox[] | null; onChange: (next: Rule) => void; onRemove: () => void }) {
  const n = String(index + 1);
  return (
    // PST-T-15.6: a rule is a region of the editing card, not a card inside it — rules are divided by
    // hairlines (settings.css), never boxed.
    <Section title={`Rule ${n}`} headingLevel={3} surface="plain" className="pr-rule">
      <Stack gap="12">
        <Cluster gap="12" align="end">
          <FormField label="When">
            <Select appearance="filled"
              options={FIELDS}
              value={rule.field}
              onValueChange={(v) => {
                onChange({ ...rule, field: v as RuleField });
              }}
            />
          </FormField>
          <FormField label="Match">
            <Select appearance="filled"
              options={MATCHES}
              value={rule.match}
              onValueChange={(v) => {
                onChange({ ...rule, match: v as RuleMatch });
              }}
            />
          </FormField>
          <FormField label="Text" width="md">
            <Input appearance="filled"
              value={rule.value}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                onChange({ ...rule, value: e.target.value });
              }}
            />
          </FormField>
          <FormField label="Then">
            <Select appearance="filled"
              options={ACTIONS}
              // A bucket is a kind of move: the destination picker holds both.
              value={rule.action === 'bucket' ? 'move' : rule.action}
              onValueChange={(v) => {
                const action = v as RuleAction;
                onChange({ ...rule, action, target: action === 'move' ? rule.target : '' });
              }}
            />
          </FormField>
          {rule.action === 'move' || rule.action === 'bucket' ? (
            <FormField label="Destination" width="md">
              <Select appearance="filled"
                options={destinationOptions(mailboxes, rule)}
                value={destinationValue(rule)}
                placeholder="Choose where"
                onValueChange={(v) => {
                  onChange(applyDestination(rule, v));
                }}
              />
            </FormField>
          ) : null}
        </Cluster>
        {/* Removing an unsaved row destroys nothing, so it is not red (P17: never red in a row). */}
        <Cluster justify="end">
          <Button variant="ghost" size="sm" aria-label={`Remove rule ${n}`} onClick={onRemove}>
            Remove
          </Button>
        </Cluster>
      </Stack>
    </Section>
  );
}

/** A script row's one action as a button, or its two behind ⋯ — never red in the row. */
function ScriptRowActions({ script, openName, busy, onEdit, onDelete }: { script: SieveScriptSummary; openName: string; busy: boolean; onEdit: () => void; onDelete: () => void }) {
  const actions = scriptActions(script, openName);
  if (actions.length === 0) return null;
  if (actions.length === 1) {
    const edit = actions[0] === 'edit';
    return (
      <Button size="sm" variant="secondary" disabled={busy} aria-label={`${edit ? 'Edit' : 'Delete'} ${script.name}`} onClick={edit ? onEdit : onDelete}>
        {edit ? 'Edit' : 'Delete'}
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger>
        <IconButton size="sm" variant="ghost" label={`Actions for ${script.name}`} icon={<MoreIcon />} disabled={busy} />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem onSelect={onEdit}>Edit</MenuItem>
        <MenuItem onSelect={onDelete}>Delete…</MenuItem>
      </MenuContent>
    </Menu>
  );
}

/**
 * Rules & sorting (PST-REQ-150, PST-REQ-194): simple rows that compile to Sieve, an "edit as Sieve"
 * view, and compile errors with their line numbers — then the other saved scripts, then the sorting
 * corrections. The same scripts Thunderbird edits over ManageSieve; the active one runs on every new
 * message.
 */
export function Rules() {
  const [scripts, setScripts] = useState<SieveScriptSummary[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [name, setName] = useState(BUILDER_SCRIPT);
  const [mode, setMode] = useState<Mode>('builder');
  const [rules, setRules] = useState<Rule[]>([]);
  const [source, setSource] = useState('');
  const [handWritten, setHandWritten] = useState(false);
  const [compileError, setCompileError] = useState<SieveCompileError | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const mailboxes = useMailboxes();
  const guard = useState(createRunGuard)[0];
  // Every write goes through the step-up contract: should the server ask for a fresh code
  // (403 step_up_required), "Confirm it is you" opens at the moment of the write, and the write runs
  // again once the code is accepted. Nothing is asked on the page itself.
  const { withStepUp, prompt } = useStepUp('Changing your rules changes where new mail goes');

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
      setLoadError(null);
      return list;
    } catch (caught) {
      setLoadError(caught);
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
      } catch (caught) {
        setLoadError(caught);
      }
    })();
  }, [load, open]);

  const current = scripts?.find((s) => s.name === name) ?? null;
  const state = runningState(current);
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

  const addRule = () => {
    setRules((all) => [...all, newRule()]);
  };

  const validRows = (): boolean => {
    if (mode !== 'builder') return true;
    const bad = rules.findIndex((r) => ruleProblem(r) !== null);
    if (bad < 0) return true;
    setFormError(`Rule ${String(bad + 1)}: ${ruleProblem(rules[bad] as Rule) ?? ''}`);
    return false;
  };

  // One write at a time, whichever control starts it (scripts.ts createRunGuard): `busy` disables the
  // buttons, and the guard refuses a second run that slips past them — a menu item, Enter, or a click
  // while "Confirm it is you" is still open over the first.
  const run = (work: () => Promise<void>) => {
    void guard.run(async () => {
      setBusy(true);
      setNotice(null);
      setFormError(null);
      setCompileError(null);
      try {
        await work();
      } catch (error) {
        const problem = compileErrorOf(error);
        if (problem !== null) setCompileError(problem);
        else setFormError(describeError(error));
      } finally {
        setBusy(false);
      }
    });
  };

  const check = () => {
    if (guard.running || !validRows()) return;
    run(async () => {
      const result = await sieveApi.check(text());
      if (result.error !== null) setCompileError(result.error);
      else setNotice('The script is valid.');
    });
  };

  const save = (activate: boolean) => (event?: SyntheticEvent) => {
    event?.preventDefault();
    if (guard.running || !validRows()) return;
    run(async () => {
      const content = text();
      const done = await withStepUp(async () => {
        await sieveApi.put(name, content);
        if (activate) await sieveApi.activate(name);
        return true;
      });
      if (done === null) return;
      if (mode === 'builder') setSource(content);
      await load();
      setNotice(activate ? `Saved. “${name}” now runs on new mail.` : `Saved “${name}”.`);
    });
  };

  const turnOff = () => {
    run(async () => {
      if ((await withStepUp(() => sieveApi.deactivate())) === null) return;
      await load();
      setNotice('No rules run now; new mail is sorted by Postroom alone.');
    });
  };

  const remove = (target: string) => {
    // The confirm stays open until the delete is done: a step-up prompt opens over it, and a
    // cancelled step-up leaves the confirm where it was, so the delete is never silently dropped.
    run(async () => {
      try {
        if ((await withStepUp(() => sieveApi.remove(target))) === null) return;
      } catch (error) {
        setConfirming(null);
        throw error;
      }
      setConfirming(null);
      const list = await load();
      if (target === name) await open(list?.find((s) => s.active)?.name ?? BUILDER_SCRIPT);
      setNotice(`Deleted “${target}”.`);
    });
  };

  const errorLine = compileError === null ? null : (text().split(/\r\n|\r|\n/)[compileError.line - 1] ?? null);
  // Turning rules off lives with the script that runs: in the Save menu when it is the one open, in
  // the Scripts card when another one runs.
  const otherRunning = scripts?.some((s) => s.active && s.name !== name) ?? false;

  return (
    // PST-T-15.6 / PST-T-17.11: the settings column — 680px, centred, a column of Section cards.
    <Page width="narrow" align="center">
      <PageHeader title="Rules & sorting" description="Sort, flag or file new mail as it arrives." />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      {loadError !== null ? (
        <LoadFailed error={loadError} what="your rules" onRetry={() => void load()} />
      ) : scripts === null ? (
        <Loading label="Loading your rules" />
      ) : (
        <>
          {/* The editor first: it is what the page is for (critique-settings 2.6 #1). */}
          <Section
            title="Your rules"
            // The builder's own script needs no name; any other script open here is named.
            {...(name === BUILDER_SCRIPT ? {} : { description: `The script “${name}”.` })}
            actions={
              <div className="pr-rules__head">
                <StatusDot size="sm" tone={state.tone}>
                  {state.label}
                </StatusDot>
                <SegmentedControl size="sm" aria-label="How to edit" items={MODES(handWritten)} value={mode} onValueChange={switchMode} />
              </div>
            }
          >
            {/* Enter in a field runs the primary action — the SplitButton's main half is the submit. */}
            <form onSubmit={save(true)} noValidate>
              <Stack gap="16">
                {mode === 'builder' ? (
                  rules.length === 0 ? (
                    <EmptyState
                      kind="empty"
                      size="row"
                      heading="No rules yet"
                      headingLevel={3}
                      action={
                        <Button size="sm" variant="secondary" onClick={addRule}>
                          Add rule
                        </Button>
                      }
                    >
                      Move, sort, flag or mark mail as read when it arrives.
                    </EmptyState>
                  ) : (
                    <div className="pr-rules">
                      {rules.map((rule, i) => (
                        <RuleRow
                          key={i}
                          rule={rule}
                          index={i}
                          mailboxes={mailboxes}
                          onChange={(next) => {
                            setRules((all) => all.map((r, j) => (j === i ? next : r)));
                          }}
                          onRemove={() => {
                            setRules((all) => all.filter((_, j) => j !== i));
                          }}
                        />
                      ))}
                      <div className="pr-rules__add">
                        <Button size="sm" variant="ghost" icon={<PlusIcon />} onClick={addRule}>
                          Add rule
                        </Button>
                      </div>
                    </div>
                  )
                ) : (
                  <FormField
                    label="Sieve script"
                    help={handWritten ? 'Written by hand or in another client, so it is edited here as Sieve.' : 'Switch back to Rules to edit rows again.'}
                  >
                    <Textarea appearance="filled"
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
                )}

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

                {/* One action row at the card foot: Check syntax leading, one Save trailing, the
                    other ways to save behind its chevron (critique-settings 2.6 #3). */}
                <FormActions
                  className="pr-setform__actions"
                  leading={
                    <Button variant="ghost" onClick={check} disabled={busy}>
                      Check syntax
                    </Button>
                  }
                >
                  {/* The main half submits the form (Enter does the same); both halves are
                      disabled while a write — or its step-up — is in flight. */}
                  <SplitButton
                    type="submit"
                    variant="primary"
                    label="Save and turn on"
                    menuLabel="More ways to save"
                    disabled={busy}
                    loading={busy}
                  >
                    <MenuItem
                      onSelect={() => {
                        save(false)();
                      }}
                    >
                      Save without turning on
                    </MenuItem>
                    {current?.active === true ? <MenuItem onSelect={turnOff}>Turn rules off</MenuItem> : null}
                  </SplitButton>
                </FormActions>
              </Stack>
            </form>
          </Section>

          {showsScripts(scripts, name) ? (
            <Section
              title="Scripts"
              description="One script runs at a time."
              actions={
                otherRunning ? (
                  <Button variant="ghost" size="sm" onClick={turnOff} disabled={busy}>
                    Turn rules off
                  </Button>
                ) : undefined
              }
            >
              <DataList aria-label="Scripts">
                {scripts.map((s) => (
                  <DataListRow
                    key={s.name}
                    title={s.name}
                    {...(s.name === name ? { description: 'Open in the editor above' } : {})}
                    meta={
                      <StatusDot size="sm" tone={runningState(s).tone}>
                        {runningState(s).label}
                      </StatusDot>
                    }
                    actions={
                      <ScriptRowActions
                        script={s}
                        openName={name}
                        busy={busy}
                        onEdit={() => {
                          run(() => open(s.name));
                        }}
                        onDelete={() => {
                          setConfirming(s.name);
                        }}
                      />
                    }
                  />
                ))}
              </DataList>
            </Section>
          ) : null}

          {/* PST-T-14.9: the corrections made from a bucket chip, each with Undo — a log, so last. */}
          <Corrections />
        </>
      )}

      <Modal
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        destructive
        title="Delete this script?"
        description={confirming === null ? '' : `“${confirming}” is deleted for good. This cannot be undone.`}
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button
              type="button"
              variant="danger"
              loading={busy}
              onClick={() => {
                if (confirming !== null) remove(confirming);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        {null}
      </Modal>
      {prompt}
    </Page>
  );
}
