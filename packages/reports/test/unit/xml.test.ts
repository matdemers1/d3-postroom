// The strict XML reader (PST-T-7.1): XXE-proof by refusing DTDs, and bounded.
import { describe, expect, it } from 'vitest';
import { ReportError, parseDmarcAggregate, parseXml } from '../../src/index.js';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ReportError) return error.code;
    throw error;
  }
  return 'no error';
};

describe('parseXml', () => {
  it('reads elements, attributes, entities, CDATA and comments', () => {
    const root = parseXml('<?xml version="1.0" encoding="UTF-8"?>\n<!-- c --><a x="1 &amp; 2"><b>&lt;hi&gt; &#65;&#x42;</b><!-- n --><c><![CDATA[<raw>]]></c><d/></a>');
    expect(root.local).toBe('a');
    expect(root.attributes['x']).toBe('1 & 2');
    expect(root.children.map((c) => c.local)).toEqual(['b', 'c', 'd']);
    expect(root.children[0]?.text).toBe('<hi> AB');
    expect(root.children[1]?.text).toBe('<raw>');
  });

  it('matches on local names under a prefix or default namespace', () => {
    const root = parseXml('<d:feedback xmlns:d="urn:ietf:params:xml:ns:dmarc-2.0"><d:version>2</d:version></d:feedback>');
    expect(root.local).toBe('feedback');
    expect(root.children[0]?.local).toBe('version');
  });

  it('refuses a DOCTYPE, so no external entity is ever resolved (XXE)', () => {
    const xxe = '<?xml version="1.0"?><!DOCTYPE feedback [<!ENTITY x SYSTEM "file:///etc/passwd">]><feedback>&x;</feedback>';
    expect(codeOf(() => parseXml(xxe))).toBe('dtd-refused');
  });

  it('refuses a billion-laughs DOCTYPE and any undeclared entity', () => {
    expect(codeOf(() => parseXml('<!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;">]><l>&b;</l>'))).toBe('dtd-refused');
    expect(codeOf(() => parseXml('<l>&nbsp;</l>'))).toBe('unknown-entity');
  });

  it('enforces size, depth, node and attribute limits', () => {
    expect(codeOf(() => parseXml('<a>' + 'x'.repeat(100) + '</a>', { maxBytes: 50 }))).toBe('too-large');
    expect(codeOf(() => parseXml('<a>'.repeat(40) + '</a>'.repeat(40)))).toBe('too-deep');
    expect(codeOf(() => parseXml('<a>' + '<b/>'.repeat(20) + '</a>', { maxNodes: 10 }))).toBe('too-many');
    expect(codeOf(() => parseXml('<a ' + Array.from({ length: 40 }, (_, i) => `a${String(i)}="1"`).join(' ') + '/>'))).toBe('too-many');
  });

  it('handles a very deep document without recursion when the limit allows it', () => {
    const n = 50_000;
    expect(parseXml('<a>'.repeat(n) + '</a>'.repeat(n), { maxDepth: n + 1 }).local).toBe('a');
  });

  it('refuses malformed documents', () => {
    for (const bad of ['', '<a>', '<a></b>', '<a x=1/>', '<a x="1" x="2"/>', 'text<a/>', '<a/><b/>', '<a>&amp</a>', '<a>\u0001</a>', '<a><!-- -- --></a>', '<a>]]></a>']) {
      expect(codeOf(() => parseXml(bad))).toBe('xml-syntax');
    }
    expect(codeOf(() => parseXml('<?xml version="1.0" encoding="ISO-8859-1"?><a/>'))).toBe('unsupported-encoding');
    expect(codeOf(() => parseXml(Buffer.from([0x3c, 0x61, 0x3e, 0xff, 0x3c, 0x2f, 0x61, 0x3e])))).toBe('xml-syntax');
  });
});

describe('parseDmarcAggregate rejects', () => {
  const minimal = (row: string): string =>
    `<feedback><report_metadata><org_name>o</org_name><report_id>1</report_id><date_range><begin>1</begin><end>2</end></date_range></report_metadata><policy_published><domain>d3cloud.io</domain><p>none</p></policy_published><record><row>${row}</row><identifiers><header_from>d3cloud.io</header_from></identifiers></record></feedback>`;
  const pe = '<policy_evaluated><disposition>none</disposition></policy_evaluated>';

  it('accepts the minimal shape', () => {
    expect(parseDmarcAggregate(minimal(`<source_ip>192.0.2.1</source_ip><count>1</count>${pe}`)).records).toHaveLength(1);
  });

  it('a wrong root, a missing field and a bad value, each with its own code', () => {
    expect(codeOf(() => parseDmarcAggregate('<html/>'))).toBe('not-dmarc');
    expect(codeOf(() => parseDmarcAggregate(minimal(`<count>1</count>${pe}`)))).toBe('not-dmarc');
    expect(codeOf(() => parseDmarcAggregate(minimal(`<source_ip>not-an-ip</source_ip><count>1</count>${pe}`)))).toBe('invalid-field');
    expect(codeOf(() => parseDmarcAggregate(minimal(`<source_ip>192.0.2.1</source_ip><count>-1</count>${pe}`)))).toBe('invalid-field');
    expect(codeOf(() => parseDmarcAggregate(minimal(`<source_ip>192.0.2.1</source_ip><count>99999999999</count>${pe}`)))).toBe('invalid-field');
  });
});
