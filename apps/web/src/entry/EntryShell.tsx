import './entry.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PostroomMark } from '../brand/PostroomMark';
import { fetchBuildLabel } from './build';
import { SortingIllustration } from './SortingIllustration';

/**
 * PST-T-17.17 (PST-REQ-005, PST-REQ-194): every screen somebody sees before they are signed in —
 * Sign in, first-run Setup, re-enrolment, and the Gate's loading and not-answering states.
 *
 * Split, after Bindery's front door: the left half says what Postroom is and names three claims a
 * person can check on the next screen; the right half is the form. Below 1024px the story is dropped
 * rather than squeezed, and the mark and name sit above the form instead.
 *
 * The aside is a landmark with its own label and an h2, so each screen keeps exactly one h1 — the
 * form's — and the form is the page's <main>.
 */
export function EntryShell({ children, wide = false }: { children: ReactNode; /** Setup and re-enrolment: about 28rem rather than 24. */ wide?: boolean }) {
  return (
    <div className="pr-entry">
      <StoryPanel />
      <main className="pr-entry__main">
        <div className={wide ? 'pr-entry__column pr-entry__column--wide' : 'pr-entry__column'}>
          <div className="pr-entry__brand pr-entry__brand--compact">
            <PostroomMark size={28} decorative /> Postroom
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

export const ENTRY_HEADLINE = 'Your mail, sorted\u00a0—';
export const ENTRY_HEADLINE_ACCENT = 'and it says why.';
export const ENTRY_PROMISE =
  'Mail for d3cloud.io on a server you own. Newsletters, receipts and notifications find their own folders; the people you write to stay in your Inbox.';
export const ENTRY_CLAIMS: readonly { title: string; detail: string }[] = [
  { title: 'Every sort shows its reason.', detail: 'Open any message and ask why it is there.' },
  { title: 'No AI reads your mail.', detail: 'Sorting is plain statistics you can inspect.' },
  { title: 'Nothing phones home.', detail: 'No telemetry, no third-party scripts.' },
];

/**
 * The arrival animation plays once per page load. The Gate's loading state, Sign in and re-enrolment
 * each mount their own shell; after the first has played, the rest arrive already settled.
 */
let arrived = false;
const ARRIVAL_MS = 1600;

function StoryPanel() {
  const build = useBuild();
  const [settled] = useState(() => arrived);
  useEffect(() => {
    if (arrived) return;
    const timer = window.setTimeout(() => {
      arrived = true;
    }, ARRIVAL_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <aside aria-label="About Postroom" className="pr-entry__story" {...(settled ? { 'data-settled': '' } : {})}>
      <div className="pr-entry__brand">
        <PostroomMark size={28} decorative /> Postroom
      </div>

      <SortingIllustration className="pr-entry__art" />

      <div className="pr-entry__pitch">
        <h2 className="pr-entry__headline">
          {ENTRY_HEADLINE} <span className="pr-entry__headline-accent">{ENTRY_HEADLINE_ACCENT}</span>
        </h2>
        <p className="pr-entry__promise">{ENTRY_PROMISE}</p>
        <ul className="pr-entry__claims">
          {ENTRY_CLAIMS.map((c) => (
            <Claim key={c.title} title={c.title}>
              {c.detail}
            </Claim>
          ))}
        </ul>
      </div>

      <footer className="pr-entry__foot">
        {build === null ? null : <span className="pr-entry__build">{build}</span>}
        <span>self-hosted</span>
      </footer>
    </aside>
  );
}

function Claim({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="pr-entry__claim">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false" className="pr-entry__tick">
        <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>
        <span className="pr-entry__claim-title">{title}</span> {children}
      </span>
    </li>
  );
}

/** The running build's short revision, or null until (and unless) /health names a real one. */
function useBuild(): string | null {
  const [build, setBuild] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void fetchBuildLabel().then((label) => {
      if (live) setBuild(label);
    });
    return () => {
      live = false;
    };
  }, []);
  return build;
}

/**
 * The heading every entry form opens with: the screen's one h1 and a muted line under it.
 * `focusOnMount` moves focus to the heading, as AuthLayout's PageHeader did, for a screen with no
 * field to land in (the Gate's not-answering state).
 */
export function EntryHeading({ title, children, focusOnMount = false }: { title: string; children?: ReactNode; focusOnMount?: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  return (
    <header className="pr-entry__heading">
      <h1 ref={ref} tabIndex={-1} className="pr-entry__title">
        {title}
      </h1>
      {children === undefined ? null : <p className="pr-entry__lede">{children}</p>}
    </header>
  );
}

/**
 * Under a form, past a hairline: small muted lines saying where to go when this screen is not the
 * answer, or (`row`) the text buttons that change step.
 */
export function EntryNotes({ children, row = false }: { children: ReactNode; row?: boolean }) {
  return <div className={row ? 'pr-entry__notes pr-entry__notes--row' : 'pr-entry__notes'}>{children}</div>;
}
