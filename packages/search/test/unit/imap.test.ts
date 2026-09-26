import { describe, expect, it } from 'vitest';
import { imapSearchToAst, imapTextCriteriaSql, type ImapTextCriterion } from '../../src/imap.js';

describe('imapSearchToAst', () => {
  it('maps FROM/TO/CC/SUBJECT/BODY onto the shared operator AST', () => {
    const criteria: ImapTextCriterion[] = [
      { key: 'FROM', value: 'alice' },
      { key: 'SUBJECT', value: 'hello' },
    ];
    expect(imapSearchToAst(criteria)).toEqual({
      root: {
        type: 'and',
        nodes: [
          { type: 'op', op: 'from', value: 'alice' },
          { type: 'op', op: 'subject', value: 'hello' },
        ],
      },
    });
  });

  it('maps TEXT to a plain word (searches subject, from, to and body)', () => {
    expect(imapSearchToAst([{ key: 'TEXT', value: 'hello' }])).toEqual({ root: { type: 'word', value: 'hello' } });
  });

  it('maps a HEADER on a known field to the matching operator', () => {
    expect(imapSearchToAst([{ key: 'HEADER', field: 'Subject', value: 'hi' }])).toEqual({ root: { type: 'op', op: 'subject', value: 'hi' } });
  });

  it('maps an unindexed HEADER to a leaf that can never match', () => {
    expect(imapSearchToAst([{ key: 'HEADER', field: 'X-Custom', value: 'anything' }])).toEqual({ root: { type: 'or', nodes: [] } });
  });

  it('returns a null root for no criteria', () => {
    expect(imapSearchToAst([])).toEqual({ root: null });
  });
});

describe('imapTextCriteriaSql', () => {
  it('produces SQL text referencing the expected column for each key', () => {
    expect(imapTextCriteriaSql('BODY', 'x').sql).toContain('body_text');
    expect(imapTextCriteriaSql('FROM', 'x').sql).toContain('from_text');
    expect(imapTextCriteriaSql('TO', 'x').sql).toContain('to_text');
    expect(imapTextCriteriaSql('CC', 'x').sql).toContain('to_text');
    expect(imapTextCriteriaSql('SUBJECT', 'x').sql).toContain('ms.subject');
    expect(imapTextCriteriaSql('TEXT', 'x').sql).toContain('body_text');
  });

  it('never inlines the value into the SQL text (parameterized only)', () => {
    const sql = imapTextCriteriaSql('SUBJECT', "'; DROP TABLE message_search; --");
    expect(sql.sql).not.toContain('DROP TABLE');
    expect(sql.values.some((v) => typeof v === 'string' && v.includes('DROP TABLE'))).toBe(true);
  });

  it("matches nothing for a HEADER field this schema doesn't index", () => {
    expect(imapTextCriteriaSql('HEADER', 'x', 'X-Custom').sql).toContain('FALSE');
  });
});
