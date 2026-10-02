// PST-T-17.18 (PST-REQ-198): a text field whose value is also in the URL keeps its own text, because
// React Router 7 lands the URL a transition later and a controlled input bound to the URL dropped
// the keys typed in between ("g" then "s" in Contacts' search left "s"). The unit environment is Node
// with no DOM, so the model is tested here and the fields' wiring is held by a source scan; the
// browser half is e2e/tests/places.spec.ts ('typing in a field is not a chord').
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { urlTextArrived, urlTextInit, urlTextTyped, type UrlText } from '../../src/components/useUrlText';

const read = (rel: string): string => readFileSync(join(__dirname, '../../src', rel), 'utf8');

/** Types each value in turn with the URL still at `url`, as happens before a transition lands. */
function typeAll(state: UrlText, url: string, values: string[]): { state: UrlText; writes: string[] } {
  const writes: string[] = [];
  for (const value of values) {
    const next = urlTextTyped(state, value, url);
    state = next.state;
    if (next.write) writes.push(value);
  }
  return { state, writes };
}

describe('a URL-backed text field', () => {
  it('keeps every key typed before the URL catches up', () => {
    const { state, writes } = typeAll(urlTextInit(''), '', ['g', 'gs']);
    expect(state.text).toBe('gs');
    expect(writes).toEqual(['g', 'gs']);
  });

  it('ignores the echoes of its own writes, in order, and does not snap back to an older one', () => {
    let { state } = typeAll(urlTextInit(''), '', ['g', 'gs', 'gsx']);
    state = urlTextArrived(state, 'g');
    expect(state.text).toBe('gsx');
    expect(state.inFlight).toEqual(['gs', 'gsx']);
    state = urlTextArrived(state, 'gsx');
    expect(state).toEqual({ text: 'gsx', inFlight: [] });
  });

  it('settles every write up to an echo when the transition skips values', () => {
    let { state } = typeAll(urlTextInit(''), '', ['a', 'ab', 'abc']);
    state = urlTextArrived(state, 'abc');
    expect(state).toEqual({ text: 'abc', inFlight: [] });
  });

  it('settles a round trip that ends where it started', () => {
    const typed = typeAll(urlTextInit(''), '', ['g', '']);
    expect(typed.writes).toEqual(['g', '']);
    const state = urlTextArrived(typed.state, '');
    expect(state).toEqual({ text: '', inFlight: [] });
    // With nothing left in flight, a later outside change to 'g' is not mistaken for an echo.
    expect(urlTextArrived(state, 'g').text).toBe('g');
  });

  it('follows a change that did not come from the field: Back, a link, a reload', () => {
    let state = urlTextInit('alice');
    state = urlTextArrived(state, 'bob');
    expect(state).toEqual({ text: 'bob', inFlight: [] });
    ({ state } = typeAll(state, 'bob', ['bo']));
    state = urlTextArrived(state, '');
    expect(state).toEqual({ text: '', inFlight: [] });
  });

  it('does not write a value the URL already holds or is about to', () => {
    expect(urlTextTyped(urlTextInit('x'), 'x', 'x').write).toBe(false);
    const { state } = typeAll(urlTextInit(''), '', ['y']);
    expect(urlTextTyped(state, 'y', '').write).toBe(false);
  });

  it('is what Contacts search and the Outbound queue domain filter render, not the URL directly', () => {
    const contacts = read('contacts/Contacts.tsx');
    expect(contacts).toMatch(/useUrlText\(query,/);
    expect(contacts).toMatch(/value=\{search\}/);
    expect(contacts).not.toMatch(/value=\{query\}/);
    const queue = read('screens/AdminQueue.tsx');
    expect(queue).toMatch(/useUrlText\(domain,/);
    expect(queue).toMatch(/value=\{domainText\}/);
    expect(queue).not.toMatch(/value=\{domain\}/);
  });
});
