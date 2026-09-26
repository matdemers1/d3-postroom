// PST-T-8.6: the hand-rolled plist writer escapes correctly and produces a plist Apple's own
// `plutil` accepts, when available (macOS/CI-on-macOS only — the assertion is skipped elsewhere).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { escapeXml, writePlist } from '../../src/mobileconfig/plist.js';

function plutilAvailable(): boolean {
  try {
    execFileSync('plutil', ['-help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('escapeXml', () => {
  it('escapes &, < and > and leaves everything else alone', () => {
    expect(escapeXml('Tom & Jerry <3> "quote" \'apos\'')).toBe('Tom &amp; Jerry &lt;3&gt; "quote" \'apos\'');
  });
});

describe('writePlist', () => {
  it('emits the XML declaration, DOCTYPE and one root dict', () => {
    const xml = writePlist({ Hello: 'World' });
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
    expect(xml).toContain('<!DOCTYPE plist PUBLIC');
    expect(xml).toContain('<plist version="1.0">');
    expect(xml).toContain('<key>Hello</key>');
    expect(xml).toContain('<string>World</string>');
  });

  it('escapes string values and dict keys', () => {
    const xml = writePlist({ 'A & B': '<script>alert(1)</script>' });
    expect(xml).toContain('<key>A &amp; B</key>');
    expect(xml).toContain('<string>&lt;script&gt;alert(1)&lt;/script&gt;</string>');
    expect(xml).not.toContain('<script>');
  });

  it('renders booleans, integers, arrays and nested dicts', () => {
    const xml = writePlist({
      Flag: true,
      Off: false,
      Count: 3,
      List: ['a', 'b'],
      Nested: { Inner: 1 },
      Empty: [],
    });
    expect(xml).toContain('<true/>');
    expect(xml).toContain('<false/>');
    expect(xml).toContain('<integer>3</integer>');
    expect(xml).toContain('<array>\n');
    expect(xml).toContain('<array/>');
    expect(xml).toContain('<key>Inner</key>');
  });

  it('round-trips through a minimal hand-written parser', () => {
    // A second, independent reader of the same format: proof the writer's nesting is well-formed,
    // not just that it looks right by eye.
    const xml = writePlist({ Name: 'Alice & Bob', Age: 42, Active: true, Tags: ['x', 'y'] });
    const parsed = parseSimplePlist(xml);
    expect(parsed).toEqual({ Name: 'Alice & Bob', Age: 42, Active: true, Tags: ['x', 'y'] });
  });
});

describe.skipIf(!plutilAvailable())('plutil -lint (macOS)', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a profile-shaped plist with special characters in string values', () => {
    dir = mkdtempSync(join(tmpdir(), 'pst-mobileconfig-'));
    const file = join(dir, 'p.mobileconfig');
    writeFileSync(
      file,
      writePlist({
        PayloadContent: [{ PayloadType: 'com.apple.mail.managed', PayloadUUID: 'abc', EmailAddress: 'a&b<c>@d3cloud.io', IncomingPassword: 'p"a\'ss' }],
        PayloadDisplayName: 'Postroom (a&b@d3cloud.io)',
        PayloadIdentifier: 'io.d3cloud.postroom.test',
        PayloadOrganization: 'd3cloud.io',
        PayloadRemovalDisallowed: false,
        PayloadType: 'Configuration',
        PayloadUUID: 'def',
        PayloadVersion: 1,
      }),
    );
    expect(() => {
      execFileSync('plutil', ['-lint', file], { stdio: 'pipe' });
    }).not.toThrow();
  });
});

// A minimal plist reader for exactly the shapes writePlist can produce — never used for anything
// but this test, so it does not need to handle <data>, <real> or comments.
function parseSimplePlist(xml: string): unknown {
  const bodyStart = xml.indexOf('<plist version="1.0">') + '<plist version="1.0">'.length;
  const bodyEnd = xml.lastIndexOf('</plist>');
  const body = xml.slice(bodyStart, bodyEnd).trim();
  const { value } = readValue(body, 0);
  return value;
}

function unescape(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function readValue(s: string, i: number): { value: unknown; next: number } {
  const rest = s.slice(i);
  if (rest.startsWith('<dict/>')) return { value: {}, next: i + '<dict/>'.length };
  if (rest.startsWith('<array/>')) return { value: [], next: i + '<array/>'.length };
  if (rest.startsWith('<true/>')) return { value: true, next: i + '<true/>'.length };
  if (rest.startsWith('<false/>')) return { value: false, next: i + '<false/>'.length };
  if (rest.startsWith('<dict>')) {
    let j = i + '<dict>'.length;
    const out: Record<string, unknown> = {};
    for (;;) {
      const after = s.slice(j).trimStart();
      j = s.length - after.length;
      if (s.slice(j).startsWith('</dict>')) return { value: out, next: j + '</dict>'.length };
      const keyMatch = /^<key>([\s\S]*?)<\/key>/.exec(s.slice(j));
      if (keyMatch === null) throw new Error('expected <key>');
      const key = unescape(keyMatch[1] ?? '');
      j += keyMatch[0].length;
      const trimmed = s.slice(j).trimStart();
      j = s.length - trimmed.length;
      const read = readValue(s, j);
      out[key] = read.value;
      j = read.next;
    }
  }
  if (rest.startsWith('<array>')) {
    let j = i + '<array>'.length;
    const out: unknown[] = [];
    for (;;) {
      const after = s.slice(j).trimStart();
      j = s.length - after.length;
      if (s.slice(j).startsWith('</array>')) return { value: out, next: j + '</array>'.length };
      const read = readValue(s, j);
      out.push(read.value);
      j = read.next;
    }
  }
  const stringMatch = /^<string>([\s\S]*?)<\/string>/.exec(rest);
  if (stringMatch !== null) return { value: unescape(stringMatch[1] ?? ''), next: i + stringMatch[0].length };
  const intMatch = /^<integer>([\s\S]*?)<\/integer>/.exec(rest);
  if (intMatch !== null) return { value: Number(intMatch[1]), next: i + intMatch[0].length };
  throw new Error(`unrecognized plist token at: ${rest.slice(0, 40)}`);
}
