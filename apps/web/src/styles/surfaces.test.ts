// PST-T-14.4 (PST-REQ-189, PST-ADR-011 §2–3): surfaces and fields. A source scan, so a new screen
// that forgets `appearance="filled"` fails here rather than in a screenshot.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

// Fields owned by other work in flight: the list search becomes a SearchField, the composer is
// being reworked, and the palette's input is the palette's own. Drop an entry once it is filled.
const PENDING = new Set(['mail/Composer.tsx']);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? tsxFiles(full) : name.endsWith('.tsx') ? [full] : [];
  });
}

const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

describe('filled fields', () => {
  it('every Input, Textarea and Select in the webmail is appearance="filled"', () => {
    const outlined: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (PENDING.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/<(Input|Textarea|Select)(?=[\s>/])/g)) {
        const next = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
        if (!/^\s+appearance="filled"/.test(next)) outlined.push(`${rel}: <${m[1] ?? ''}`);
      }
    }
    expect(outlined).toEqual([]);
  });

  it('PasswordInput, which has no appearance prop, gets the filled recipe with one focus ring', () => {
    const css = read('styles/fields.css');
    expect(css).toMatch(/\.d3-pw > \.d3-inp \{[^}]*height: 36px;[^}]*font-size: var\(--text-14\);[^}]*background: var\(--color-bg\);/);
    expect(css).toMatch(/focus-visible\) \{\s*border-color: var\(--color-border-field\);\s*outline: var\(--focus-width\) solid var\(--color-focus\);\s*outline-offset: calc\(-1 \* var\(--border-width\)\);/);
    for (const screen of ['screens/Shell.tsx', 'screens/SignIn.tsx', 'screens/Setup.tsx']) expect(read(screen)).toContain("import '../styles/fields.css';");
  });
});

describe('surfaces', () => {
  it('Mail, Settings and the Admin console share one recessed AppShell', () => {
    expect(read('screens/Shell.tsx')).toMatch(/<AppShell\s+navTone="recessed"/);
  });

  it('the list and the reading pane share --color-surface with one hairline between them', () => {
    const css = read('mail/mail.css');
    const rule = (sel: string): string => new RegExp(`\\n${sel.replace(/[.[\]']/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    expect(rule('.pr-mail')).toContain('background: var(--color-surface);');
    expect(rule('.pr-mail__list')).toContain('background: var(--color-surface);');
    expect(rule('.pr-mail__list')).toContain('border-right: var(--border-width) solid var(--color-border);');
    expect(rule('.pr-reader')).not.toContain('background');
  });

  it('only the Inbox count is loud; the buckets, Junk/Rejects and More are quiet', () => {
    const shell = read('screens/Shell.tsx');
    // The primary group passes a count for the Inbox alone; every other mailbox group is quiet.
    expect(shell).toContain('count={m.id === inbox?.id ? m.unseen : 0}');
    expect(shell.match(/<SideNavGroup title="(Sorted for you|Junk and rejects|More)"[^>]*className="pr-nav-quiet"/g)).toHaveLength(3);
    expect(read('styles/places.css')).toMatch(/\.pr-nav-quiet \.d3-snav__item\[aria-current='page'\] \.d3-bdg--count \{\s*background: var\(--color-bg\);/);
  });
});
