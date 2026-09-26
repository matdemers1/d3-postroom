import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { baseSubject, normalizeMsgId, threadMessages, type ThreadInput, type ThreadTree } from '../../src/index.js';

const day = (n: number): Date => new Date(2026, 0, n);

function msg(partial: Partial<ThreadInput> & Pick<ThreadInput, 'id' | 'subject' | 'date' | 'from' | 'to'>): ThreadInput {
  return { references: [], ...partial };
}

function flatten(trees: ThreadTree[]): ThreadTree[] {
  const out: ThreadTree[] = [];
  const walk = (t: ThreadTree): void => {
    out.push(t);
    for (const c of t.children) walk(c);
  };
  for (const t of trees) walk(t);
  return out;
}

function findById(trees: ThreadTree[], id: string): ThreadTree | undefined {
  return flatten(trees).find((t) => t.id === id || t.message?.id === id);
}

function messageIds(trees: ThreadTree[]): string[] {
  return flatten(trees)
    .map((t) => t.message?.id)
    .filter((id): id is string => id !== undefined);
}

describe('normalizeMsgId', () => {
  it('strips angle brackets and whitespace', () => {
    expect(normalizeMsgId('<a@b>')).toBe('a@b');
    expect(normalizeMsgId('  <a@b>  ')).toBe('a@b');
    expect(normalizeMsgId('a@b')).toBe('a@b');
    expect(normalizeMsgId('<a@b\r\n c>')).toBe('a@b c');
  });
});

describe('baseSubject', () => {
  it('strips Re:/Fwd:/Fw:/Aw:/Sv: prefixes', () => {
    expect(baseSubject('Re: foo')).toBe('foo');
    expect(baseSubject('Fwd: foo')).toBe('foo');
    expect(baseSubject('FW: foo')).toBe('foo');
    expect(baseSubject('Aw: foo')).toBe('foo');
    expect(baseSubject('Sv: foo')).toBe('foo');
    expect(baseSubject('Re: Re: foo')).toBe('foo');
  });

  it('strips a trailing "(fwd)" (RFC 5256)', () => {
    expect(baseSubject('foo (fwd)')).toBe('foo');
    expect(baseSubject('foo (fwd) (fwd)')).toBe('foo');
  });

  it('strips list-tag blobs around a reply marker', () => {
    expect(baseSubject('[list] Re: foo')).toBe('foo');
    expect(baseSubject('Re: [list] foo')).toBe('foo');
  });

  it('normalizes case and whitespace', () => {
    expect(baseSubject('  Foo   Bar  ')).toBe('foo bar');
  });

  it('unwraps "[fwd: ...]"', () => {
    expect(baseSubject('[fwd: foo]')).toBe('foo');
  });
});

describe('threadMessages: JWZ fixtures', () => {
  it('threads a simple reply chain by References', () => {
    const a = msg({ id: 'a', messageId: '<a@x>', subject: 'foo', date: day(1), from: 'a@x', to: 'b@x' });
    const b = msg({ id: 'b', messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'], subject: 'Re: foo', date: day(2), from: 'b@x', to: 'a@x' });
    const c = msg({ id: 'c', messageId: '<c@x>', inReplyTo: '<b@x>', references: ['<a@x>', '<b@x>'], subject: 'Re: foo', date: day(3), from: 'a@x', to: 'b@x' });

    const trees = threadMessages([a, b, c]);
    expect(trees).toHaveLength(1);
    expect(trees[0]?.message?.id).toBe('a');
    expect(trees[0]?.children[0]?.message?.id).toBe('b');
    expect(trees[0]?.children[0]?.children[0]?.message?.id).toBe('c');
    expect(messageIds(trees).sort()).toEqual(['a', 'b', 'c']);
  });

  it('promotes a reply\'s children when its parent is missing, via a dummy container', () => {
    // "a" never appears in the corpus, but two messages reference it. Both should end up as
    // siblings (children of the dummy container standing in for "a").
    const b = msg({ id: 'b', messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'], subject: 'Re: foo', date: day(2), from: 'b@x', to: 'a@x' });
    const c = msg({ id: 'c', messageId: '<c@x>', inReplyTo: '<a@x>', references: ['<a@x>'], subject: 'Re: foo', date: day(3), from: 'c@x', to: 'a@x' });

    const trees = threadMessages([b, c]);
    expect(trees).toHaveLength(1);
    expect(trees[0]?.message).toBeNull();
    const kids = trees[0]?.children.map((t) => t.message?.id).sort() ?? [];
    expect(kids).toEqual(['b', 'c']);
  });

  it('promotes a single child up when its dummy parent has exactly one child', () => {
    // "a" is missing, and only "b" references it: the dummy container is elided and "b" becomes
    // a root of the forest directly.
    const b = msg({ id: 'b', messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'], subject: 'unique subject b', date: day(2), from: 'b@x', to: 'a@x' });

    const trees = threadMessages([b]);
    expect(trees).toHaveLength(1);
    expect(trees[0]?.message?.id).toBe('b');
  });

  it('links across a gap in References (an intermediate message never seen)', () => {
    const a = msg({ id: 'a', messageId: '<a@x>', subject: 'foo', date: day(1), from: 'a@x', to: 'b@x' });
    // "b" (referenced by c, in between a and c) never arrives.
    const c = msg({ id: 'c', messageId: '<c@x>', references: ['<a@x>', '<b@x>'], subject: 'Re: foo', date: day(3), from: 'c@x', to: 'a@x' });

    const trees = threadMessages([a, c]);
    expect(trees).toHaveLength(1);
    expect(trees[0]?.message?.id).toBe('a');
    // "b"'s dummy container has exactly one child ("c"), so it is promoted up under "a".
    expect(trees[0]?.children[0]?.message?.id).toBe('c');
  });

  it('gives a duplicate Message-ID a synthetic id for the later message', () => {
    const a1 = msg({ id: 'a1', messageId: '<dup@x>', subject: 'foo', date: day(1), from: 'a@x', to: 'b@x' });
    const a2 = msg({ id: 'a2', messageId: '<dup@x>', subject: 'foo', date: day(2), from: 'c@x', to: 'd@x' });

    const trees = threadMessages([a1, a2]);
    expect(messageIds(trees).sort()).toEqual(['a1', 'a2']);
    // Two distinct message-bearing containers: the duplicate is never merged into the first
    // message's container and clobbers nothing (same subject then merges them as siblings, but
    // under separate containers).
    const messageContainers = flatten(trees).filter((t) => t.message !== null);
    expect(new Set(messageContainers.map((t) => t.id)).size).toBe(2);
  });

  it('never creates a cycle when References form one', () => {
    const a = msg({ id: 'a', messageId: '<a@x>', references: ['<b@x>'], subject: 'foo', date: day(1), from: 'a@x', to: 'b@x' });
    const b = msg({ id: 'b', messageId: '<b@x>', references: ['<a@x>'], subject: 'Re: foo', date: day(2), from: 'b@x', to: 'a@x' });

    const trees = threadMessages([a, b]);
    expect(messageIds(trees).sort()).toEqual(['a', 'b']);
    // A valid forest: no container should be its own descendant.
    for (const t of flatten(trees)) {
      const stack = [...t.children];
      while (stack.length > 0) {
        const cur = stack.pop();
        if (cur === undefined) continue;
        expect(cur).not.toBe(t);
        stack.push(...cur.children);
      }
    }
  });

  it('groups the root set by subject when References/In-Reply-To are absent ("Re: foo" joins "foo")', () => {
    const a = msg({ id: 'a', messageId: '<a@x>', subject: 'foo', date: day(1), from: 'a@x', to: 'b@x' });
    const b = msg({ id: 'b', messageId: '<b@x>', subject: 'Re: foo', date: day(2), from: 'b@x', to: 'a@x' });

    const trees = threadMessages([a, b]);
    expect(trees).toHaveLength(1);
    expect(trees[0]?.message?.id).toBe('a');
    expect(trees[0]?.children[0]?.message?.id).toBe('b');
  });

  it('threads "Fwd: foo" under "foo" the same as "Re: foo" (RFC 5256 strips fwd too)', () => {
    const a = msg({ id: 'a', messageId: '<a@x>', subject: 'foo', date: day(1), from: 'a@x', to: 'b@x' });
    const b = msg({ id: 'b', messageId: '<b@x>', subject: 'Fwd: foo', date: day(2), from: 'c@x', to: 'd@x' });

    const trees = threadMessages([a, b]);
    expect(trees).toHaveLength(1);
    expect(trees[0]?.message?.id).toBe('a');
    expect(trees[0]?.children[0]?.message?.id).toBe('b');
  });

  it('links a message with only In-Reply-To (no References)', () => {
    const a = msg({ id: 'a', messageId: '<a@x>', subject: 'foo', date: day(1), from: 'a@x', to: 'b@x' });
    const b = msg({ id: 'b', messageId: '<b@x>', inReplyTo: '<a@x>', subject: 'Re: foo', date: day(2), from: 'b@x', to: 'a@x' });

    const trees = threadMessages([a, b]);
    expect(trees).toHaveLength(1);
    expect(trees[0]?.children[0]?.message?.id).toBe('b');
  });

  it('threads correctly when the child arrives before its parent in the input array', () => {
    const a = msg({ id: 'a', messageId: '<a@x>', subject: 'foo', date: day(1), from: 'a@x', to: 'b@x' });
    const b = msg({ id: 'b', messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'], subject: 'Re: foo', date: day(2), from: 'b@x', to: 'a@x' });

    const trees = threadMessages([b, a]); // child first
    expect(trees).toHaveLength(1);
    expect(trees[0]?.message?.id).toBe('a');
    expect(trees[0]?.children[0]?.message?.id).toBe('b');
  });

  it('a message with References never falls back to subject grouping with an unrelated root', () => {
    const a = msg({ id: 'a', messageId: '<a@x>', subject: 'foo', date: day(1), from: 'a@x', to: 'b@x' });
    // "b" shares a's subject but links to a completely different, present parent via References.
    const parent = msg({ id: 'parent', messageId: '<parent@x>', subject: 'unrelated', date: day(1), from: 'z@x', to: 'y@x' });
    const b = msg({ id: 'b', messageId: '<b@x>', references: ['<parent@x>'], inReplyTo: '<parent@x>', subject: 'foo', date: day(2), from: 'b@x', to: 'a@x' });

    const trees = threadMessages([a, parent, b]);
    expect(trees).toHaveLength(2);
    const parentTree = findById(trees, 'parent');
    expect(parentTree?.children[0]?.message?.id).toBe('b');
    const aTree = trees.find((t) => t.message?.id === 'a');
    expect(aTree?.children).toHaveLength(0);
  });

  it('never throws, never loses a message, and never produces a cycle for arbitrary reference graphs', () => {
    const idArb = fc.constantFrom('a', 'b', 'c', 'd', 'e');
    const inputArb = fc.array(
      fc.record({
        id: fc.uuid(),
        messageId: fc.option(fc.tuple(idArb, idArb).map(([x, y]) => `<${x}${y}@x>`), { nil: undefined }),
        inReplyTo: fc.option(fc.tuple(idArb, idArb).map(([x, y]) => `<${x}${y}@x>`), { nil: undefined }),
        references: fc.array(fc.tuple(idArb, idArb).map(([x, y]) => `<${x}${y}@x>`), { maxLength: 4 }),
        subject: fc.constantFrom('foo', 'Re: foo', 'bar', 'Fwd: bar', ''),
        date: fc.integer({ min: 0, max: 1_000_000 }).map((n) => new Date(n)),
        from: fc.constantFrom('a@x', 'b@x'),
        to: fc.constantFrom('a@x', 'b@x'),
      }),
      { maxLength: 10 },
    );

    fc.assert(
      fc.property(inputArb, (msgs) => {
        const inputs: ThreadInput[] = msgs.map((m) => ({
          id: m.id,
          references: m.references,
          subject: m.subject,
          date: m.date,
          from: m.from,
          to: m.to,
          ...(m.messageId === undefined ? {} : { messageId: m.messageId }),
          ...(m.inReplyTo === undefined ? {} : { inReplyTo: m.inReplyTo }),
        }));
        let trees: ThreadTree[] = [];
        expect(() => {
          trees = threadMessages(inputs);
        }).not.toThrow();

        expect(messageIds(trees).sort()).toEqual(inputs.map((m) => m.id).sort());

        for (const t of flatten(trees)) {
          const seen = new Set<ThreadTree>();
          const stack = [...t.children];
          while (stack.length > 0) {
            const cur = stack.pop();
            if (cur === undefined) continue;
            expect(cur).not.toBe(t);
            expect(seen.has(cur)).toBe(false);
            seen.add(cur);
            stack.push(...cur.children);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
