// PST-DA-050 (COPY-05/11/12/14/19): a scan over apps/web/src's .tsx files for the exact words the
// finding retired, scoped to what a person actually reads — JSX text nodes and the label/title/
// help/aria-label/placeholder/description/heading props that name a field or an action. Code
// identifiers (killAlias, cancelled as a DeliveryState, setLogin) and comments are deliberately out
// of scope: this is a copy test, not a rename.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../src');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? tsxFiles(full) : name.endsWith('.tsx') ? [full] : [];
  });
}

const COPY_PROP = /(?:\blabel|\btitle|\bhelp|aria-label|placeholder|\bdescription|\bheading)\s*=\s*"([^"]*)"/g;
// A JSX text node: `>...<` on one line, with no braces or angle brackets inside (so it is not
// itself markup or an expression container).
// Text between tags, including text on its own line(s) between an opening and a closing tag.
const JSX_TEXT = />([^<>{}]+)</g;

const RETIRED: { pattern: RegExp; why: string }[] = [
  { pattern: /\bKill\b|\bRevive\b|\bKilled\b/, why: "verb-of-violence copy (COPY-05) — use 'Turn off' / 'Turn on' / 'Off'" },
  { pattern: /\bOrganise\b|\bOrganisation\b/, why: "British spelling (COPY-12) — use 'Organize' / 'Organization'" },
  { pattern: /e-mail/i, why: "British spelling (COPY-12) — use 'email'" },
  { pattern: /\bLogin\b/, why: "field label (COPY-19) — use 'Username' or 'Address or username'" },
  { pattern: /Blind copy/, why: "composer label mismatch (COPY-11) — use 'Bcc'" },
  { pattern: /Filters \(ManageSieve\)/, why: "COPY-14 — use 'Rules (ManageSieve)'" },
];

function copyStringsIn(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(COPY_PROP)) if (match[1] !== undefined) found.push(match[1]);
  for (const match of source.matchAll(JSX_TEXT)) if (match[1] !== undefined) found.push(match[1]);
  return found;
}

describe('retired copy never reappears in user-facing JSX (PST-DA-050)', () => {
  const files = tsxFiles(SRC);
  expect(files.length).toBeGreaterThan(10); // the scan itself is not accidentally scanning nothing

  for (const file of files) {
    const relative = file.slice(SRC.length + 1);
    it(`${relative} has none of the retired words in its JSX text or label/title/help props`, () => {
      const strings = copyStringsIn(readFileSync(file, 'utf8'));
      for (const text of strings) {
        for (const { pattern, why } of RETIRED) {
          expect(pattern.test(text), `${relative}: "${text}" — ${why}`).toBe(false);
        }
      }
    });
  }
});
