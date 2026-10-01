// PST-T-17.8 (PST-REQ-155, PST-REQ-194; critique-settings X12/X13, critique-admin X11/X13/X14): the
// phone's large-title context bar, its trailing slot, and the shell around them. The unit
// environment is Node with no DOM, so the collapse is tested through its injected observers (fakes
// stand in for IntersectionObserver and MutationObserver), the bar and the slot hooks are rendered to
// strings, and the shell's wiring is held by a source scan. The browser half is
// e2e/tests/mobile.spec.ts and e2e/tests/titles.spec.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ContextBarAction, ContextBarSlotProvider, createBarSlot, useContextBarAction, useHasContextBar } from '../../src/mobile/barSlot';
import { ContextBar } from '../../src/mobile/ContextBar';
import { headingUnderBar, LARGE_TITLE_SELECTOR, observeLargeTitle, type BarElement, type ObserverEnv, type TitleEntry } from '../../src/mobile/largeTitle';
import { PlaceIndex } from '../../src/mobile/PlaceIndex';

const read = (rel: string): string => readFileSync(join(__dirname, '../../src', rel), 'utf8');
const inRouter = (node: ReactNode): string => renderToStaticMarkup(createElement(MemoryRouter, null, node));

// --- Fakes for the observers -----------------------------------------------------------------------

interface FakeIO {
  callback: (entries: TitleEntry[]) => void;
  options: { rootMargin: string; threshold: number };
  targets: unknown[];
  disconnected: boolean;
}

function fakeEnv(): { env: ObserverEnv; ios: FakeIO[]; mutate: () => void; moDisconnected: () => boolean } {
  const ios: FakeIO[] = [];
  let moCallback: (() => void) | null = null;
  let moOff = false;
  const env: ObserverEnv = {
    IntersectionObserver: class {
      record: FakeIO;
      constructor(callback: (entries: TitleEntry[]) => void, options: { rootMargin: string; threshold: number }) {
        this.record = { callback, options, targets: [], disconnected: false };
        ios.push(this.record);
      }
      observe(target: never): void {
        this.record.targets.push(target);
      }
      disconnect(): void {
        this.record.disconnected = true;
      }
    },
    MutationObserver: class {
      constructor(callback: () => void) {
        moCallback = callback;
      }
      observe(): void {
        // The frame is watched; the test fires `mutate` itself.
      }
      disconnect(): void {
        moOff = true;
      }
    },
  };
  return { env, ios, mutate: () => moCallback?.(), moDisconnected: () => moOff };
}

/** A bar whose bottom edge is at `bottom`, in a frame whose PageHeader h1 is `heading()`. */
function fakeBar(heading: () => unknown, bottom = 52): { bar: BarElement; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    bar: {
      parentElement: {
        querySelector: (selector: string) => {
          asked.push(selector);
          return heading();
        },
      },
      getBoundingClientRect: () => ({ bottom }),
    },
  };
}

const entry = (isIntersecting: boolean, bottom: number): TitleEntry => ({ isIntersecting, boundingClientRect: { bottom } });

// --- The collapse ------------------------------------------------------------------------------------

describe('headingUnderBar: the iOS large-title decision', () => {
  it('is true only once the h1 has left through the top, under the bar', () => {
    expect(headingUnderBar(entry(true, 120), 52)).toBe(false); // still showing below the bar
    expect(headingUnderBar(entry(false, 40), 52)).toBe(true); // scrolled up under the bar
    expect(headingUnderBar(entry(false, 52), 52)).toBe(true); // exactly at the bar's edge
    expect(headingUnderBar(entry(false, 1200), 52)).toBe(false); // out of view BELOW the viewport
  });
});

describe('observeLargeTitle', () => {
  it('keeps the bar empty while the page h1 shows, and gives it the title once the h1 scrolls under', () => {
    const h1 = { id: 'h1' };
    const { env, ios } = fakeEnv();
    const { bar, asked } = fakeBar(() => h1, 52);
    const seen: boolean[] = [];
    observeLargeTitle(bar, (show) => seen.push(show), env);

    expect(asked[0]).toBe(LARGE_TITLE_SELECTOR);
    expect(LARGE_TITLE_SELECTOR).toBe('.d3-ph__title');
    expect(ios).toHaveLength(1);
    expect(ios[0]?.targets).toEqual([h1]);
    // The root is the viewport less the bar: the h1 counts as showing only below the bar.
    expect(ios[0]?.options.rootMargin).toBe('-52px 0px 0px 0px');
    expect(seen).toEqual([false]);

    ios[0]?.callback([entry(true, 140)]);
    expect(seen).toEqual([false]); // no repeat report
    ios[0]?.callback([entry(false, 30)]);
    expect(seen).toEqual([false, true]);
    ios[0]?.callback([entry(true, 80)]);
    expect(seen).toEqual([false, true, false]);
  });

  it('shows the title at once on a screen with no PageHeader h1 (the place indexes)', () => {
    const { env, ios } = fakeEnv();
    const seen: boolean[] = [];
    observeLargeTitle(fakeBar(() => null).bar, (show) => seen.push(show), env);
    expect(seen).toEqual([true]);
    expect(ios).toHaveLength(0);
  });

  it('shows the title when the browser has no IntersectionObserver', () => {
    const seen: boolean[] = [];
    observeLargeTitle(fakeBar(() => ({})).bar, (show) => seen.push(show), {});
    expect(seen).toEqual([true]);
  });

  it('follows the h1 when the screen swaps it (Loading, then the page), and cleans up', () => {
    let current: unknown = null;
    const { env, ios, mutate, moDisconnected } = fakeEnv();
    const seen: boolean[] = [];
    const stop = observeLargeTitle(fakeBar(() => current).bar, (show) => seen.push(show), env);
    expect(seen).toEqual([true]); // nothing to defer to yet

    const loaded = { id: 'page h1' };
    current = loaded;
    mutate();
    expect(ios).toHaveLength(1);
    expect(ios[0]?.targets).toEqual([loaded]);
    expect(seen).toEqual([true, false]);

    mutate(); // the same h1: nothing changes
    expect(ios).toHaveLength(1);

    const replaced = { id: 'another h1' };
    current = replaced;
    mutate();
    expect(ios[0]?.disconnected).toBe(true);
    expect(ios[1]?.targets).toEqual([replaced]);

    stop();
    expect(ios[1]?.disconnected).toBe(true);
    expect(moDisconnected()).toBe(true);
  });
});

describe('ContextBar', () => {
  it('a large-title bar starts empty and flush (the h1 below it is the title), marked expanded', () => {
    const html = inRouter(createElement(ContextBar, { back: { to: '/admin', label: 'Admin' }, title: 'Outbound queue', largeTitle: true }));
    expect(html).toContain('class="pr-cbar pr-cbar--flush"');
    expect(html).toContain('data-large-title="expanded"');
    expect(html).toContain('<p class="pr-cbar__title" aria-hidden="true"></p>');
    expect(html).not.toContain('Outbound queue');
  });

  it('a plain bar keeps its title and hairline (the mail view and its levels)', () => {
    const html = inRouter(createElement(ContextBar, { title: 'Inbox' }));
    expect(html).toContain('class="pr-cbar"');
    expect(html).not.toContain('data-large-title');
    expect(html).toContain('<p class="pr-cbar__title" aria-hidden="true">Inbox</p>');
  });

  it('draws what a page registered in its slot, after its own actions', () => {
    const slot = createBarSlot();
    slot.set('page', createElement('button', { type: 'button', 'aria-label': 'Refresh' }));
    const html = inRouter(createElement(ContextBar, { title: 'Health', slot, actions: createElement('i', { id: 'own' }) }));
    expect(html).toContain('<div class="pr-cbar__actions"><i id="own"></i><button type="button" aria-label="Refresh"></button></div>');
  });

  it('an empty slot draws nothing', () => {
    const html = inRouter(createElement(ContextBar, { title: 'Health', slot: createBarSlot() }));
    expect(html).toContain('<div class="pr-cbar__actions"></div>');
  });
});

// --- The trailing slot ----------------------------------------------------------------------------

describe('createBarSlot', () => {
  it('the newest registration wins; withdrawing it brings back the one before', () => {
    const slot = createBarSlot();
    let notified = 0;
    const off = slot.subscribe(() => {
      notified += 1;
    });
    expect(slot.get()).toBeNull();
    slot.set('a', 'Refresh');
    slot.set('b', 'Re-check');
    expect(slot.get()).toBe('Re-check');
    // A re-render of the older page re-registers it, but does not jump it ahead.
    slot.set('a', 'Refresh again');
    expect(slot.get()).toBe('Re-check');
    slot.clear('b');
    expect(slot.get()).toBe('Refresh again');
    slot.clear('a');
    expect(slot.get()).toBeNull();
    expect(notified).toBe(5);
    slot.clear('never-registered');
    expect(notified).toBe(5);
    off();
    slot.set('c', 'x');
    expect(notified).toBe(5);
  });
});

describe('useContextBarAction / useHasContextBar', () => {
  function Probe() {
    const inBar = useContextBarAction(createElement('button', { type: 'button' }, 'Refresh'));
    const hasBar = useHasContextBar();
    return createElement('output', null, `${String(inBar)}/${String(hasBar)}`);
  }

  it('reports no bar on a desktop (no provider), so the page keeps the action in its PageHeader', () => {
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<output>false/false</output>');
  });

  it('reports the bar under a phone push screen’s provider', () => {
    const html = renderToStaticMarkup(createElement(ContextBarSlotProvider, { value: createBarSlot() }, createElement(Probe)));
    expect(html).toBe('<output>true/true</output>');
  });

  it('ContextBarAction renders nothing where it stands', () => {
    const html = renderToStaticMarkup(createElement(ContextBarSlotProvider, { value: createBarSlot() }, createElement(ContextBarAction, null, createElement('button', null, 'Refresh'))));
    expect(html).toBe('');
  });
});

// --- The shell around them --------------------------------------------------------------------------

describe('the phone shell for Settings and Admin', () => {
  const shell = read('screens/Shell.tsx');
  const css = read('mobile/mobile.css');

  it('gives every pushed non-mail screen a large-title bar with the slot, and provides the slot to its page', () => {
    expect(shell).toContain('largeTitle slot={barSlot}');
    expect(shell).toContain('<ContextBarSlotProvider value={barSlot}>{frame}</ContextBarSlotProvider>');
  });

  it('draws the account row on the place indexes only, never at the foot of a leaf screen (X13)', () => {
    expect(shell).not.toContain('pr-place-account');
    expect(css).not.toContain('.pr-place-account');
    expect(shell).toContain('account={accountMenu}');
    const index = inRouter(createElement(PlaceIndex, { place: 'admin', isAdmin: true, setupLeft: 0, iconFor: () => null, account: createElement('span', { id: 'acct' }) }));
    expect(index).toContain('<div class="pr-pindex__account"><span id="acct"></span></div>');
  });

  it('paints the sheet to the bottom of the viewport under a short page (X13)', () => {
    expect(shell).toContain("className={isMailView ? 'pr-push--mail' : 'pr-push--page'}");
    expect(css).toMatch(/\.pr-push--page \{\s*min-height: 100vh;\s*min-height: 100dvh;\s*background: var\(--color-surface\);/);
  });

  it("gives the Admin nav's Setup count the quiet style (X14)", () => {
    expect(shell).toContain("<SideNavGroup title={name} {...(place === 'admin' ? { className: 'pr-nav-quiet' } : {})}>");
    expect(read('styles/places.css')).toMatch(/\.pr-nav-quiet \.d3-bdg--count \{/);
  });

  it('the sender profile draws its own Back only where no context bar does (one Back on a phone)', () => {
    const profile = read('screens/SenderProfile.tsx');
    expect(profile).toContain('const hasBar = useHasContextBar();');
    expect(profile).toMatch(/hasBar \? undefined : \(\s*<Button size="sm" variant="ghost"/);
    expect(profile.match(/>\s*Back\s*</g)).toHaveLength(1);
  });
});
