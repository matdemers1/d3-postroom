// PST-T-16.2 (closes PST-DA-065 and the PST-DA-075 residual; PST-REQ-192): error boundaries at the
// root, around the palette and around each mail pane, and the Inspect drawer on drawer motion.
//
// The unit environment is Node with no DOM (vitest runs SSR; no jsdom or react-test-renderer is a
// dependency), and React's server renderer does not run error boundaries — so a thrown render cannot
// be driven end to end here. What is covered instead: the boundary's own state machine (the same
// static methods and render React calls), the fallback markup it renders, and the wiring — which
// subtree sits inside which boundary, read from the source — plus the drawer's CSS. The live
// "throw in the reading pane, the list stays" and the computed animation-timing-function of the open
// drawer are for the browser (e2e).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PaneBoundary } from '../../src/screens/PaneBoundary';

// @d3cloud/ui ships a stylesheet Node cannot import; stand-ins keep the alert's role, title and
// actions, which is all the boundary's fallback relies on.
vi.mock('@d3cloud/ui', () => ({
  Alert: ({ title, actions, children }: { title: string; actions?: unknown; children?: unknown }) =>
    createElement('div', { role: 'alert' }, createElement('strong', null, title), children as never, actions as never),
  Button: ({ children }: { children?: unknown }) => createElement('button', null, children as never),
}));

const SRC = join(import.meta.dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

type Props = ConstructorParameters<typeof PaneBoundary>[0];

/** A boundary after React caught a throw: the state getDerivedStateFromError produced, rendered. */
function failed(props: Props): string {
  const boundary = new PaneBoundary(props);
  boundary.state = { ...boundary.state, ...PaneBoundary.getDerivedStateFromError() };
  const node = boundary.render();
  return renderToStaticMarkup(createElement('div', null, node));
}

describe('PaneBoundary', () => {
  it('renders its children untouched while nothing has thrown', () => {
    const boundary = new PaneBoundary({ name: 'The page', resetKey: '/a', children: createElement('p', null, 'fine') });
    expect(renderToStaticMarkup(createElement('div', null, boundary.render()))).toBe('<div><p>fine</p></div>');
  });

  it('shows the "stopped working" alert, named for the pane, after a throw', () => {
    const html = failed({ name: 'The reading pane', resetKey: '/a', compact: true });
    expect(html).toContain('The reading pane stopped working');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Try again');
    expect(html).toContain('pr-pane-error--compact');
  });

  it('offers a full Reload at the root only', () => {
    expect(failed({ name: 'Postroom', resetKey: '/signin', reload: true })).toContain('Reload');
    expect(failed({ name: 'The message list', resetKey: '/mail', compact: true })).not.toContain('Reload');
  });

  it('puts the failed pane back in its column so the other pane stays put', () => {
    expect(failed({ name: 'The message list', resetKey: 'k', compact: true, fallbackClassName: 'pr-pane-error--list' })).toContain('pr-pane-error--list');
  });

  it('clears a caught error when the reset key changes, and not before', () => {
    const state = { failed: true, resetKey: '/a' };
    expect(PaneBoundary.getDerivedStateFromProps({ name: 'x', resetKey: '/a' }, state)).toBeNull();
    expect(PaneBoundary.getDerivedStateFromProps({ name: 'x', resetKey: '/b' }, state)).toEqual({ failed: false, resetKey: '/b' });
  });
});

/** The JSX of one boundary opening tag through its closing tag, by the name it gives the pane. */
function boundary(source: string, name: string): string {
  const start = source.indexOf(`<PaneBoundary name="${name}"`);
  expect(start, `no PaneBoundary named "${name}"`).toBeGreaterThan(-1);
  const end = source.indexOf('</PaneBoundary>', start);
  return source.slice(start, end);
}

describe('where the boundaries sit', () => {
  it('Gate is inside a boundary at the root, so SignIn and Setup throws show the alert, not an empty #root', () => {
    const app = read('App.tsx');
    expect(app).toMatch(/<RootBoundary>\s*<Gate \/>\s*<\/RootBoundary>/);
    expect(boundary(app, 'Postroom')).toContain('{children}');
    expect(app).toContain('<SignIn');
  });

  it('PlacePalette is inside a boundary', () => {
    expect(boundary(read('screens/Shell.tsx'), 'The command palette')).toContain('<PlacePalette');
  });

  it('the mail list and the reading pane each have their own boundary, and ReadingPane is only in the reader', () => {
    const view = read('mail/MailView.tsx');
    const list = boundary(view, 'The message list');
    const reader = boundary(view, 'The reading pane');
    expect(list).toContain('{listPane}');
    expect(list).not.toContain('readerPane');
    expect(reader).toContain('{readerPane}');
    expect(reader).not.toContain('listPane');
    // The split layout renders both, each guarded; neither is rendered bare.
    expect(view).toMatch(/\{guardedList\}\s*\{guardedReader\}/);
    expect(view).not.toMatch(/\{listPane\}\s*\{readerPane\}/);
  });
});

describe('the Inspect drawer motion (PST-REQ-192)', () => {
  const css = read('mail/mail.css');
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  };

  it('enters and exits on --motion-drawer, not the modal spring', () => {
    const open = rule('.d3-modal.pr-inspect');
    const closed = rule(".d3-modal.pr-inspect[data-state='closed']");
    expect(open).toContain('animation: pr-inspect-in var(--motion-drawer)');
    expect(closed).toContain('animation: pr-inspect-out var(--motion-drawer)');
    for (const block of [open, closed]) {
      expect(block).not.toContain('--motion-modal');
      expect(block).not.toContain('--ease-spring');
    }
  });

  it('keeps a reduced-motion fallback that does not travel', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('pr-inspect-in')));
    expect(reduced).toContain('pr-inspect-fade-in');
    expect(reduced).toContain('pr-inspect-fade-out');
  });

  it('is the one class the Delivery details sheet and the admin queue drawer share', () => {
    expect(read('admin/queue/QueueDrawer.tsx')).toContain('pr-inspect');
    expect(read('mail/MailView.tsx')).toContain('pr-inspect');
  });
});
