// PST-T-14.8 (PST-REQ-155, PST-REQ-192, PST-REQ-193, PST-ADR-011): the phone's two pieces of
// chrome. ContextBar is the sticky bar at the top of every push level — Back with the parent's name,
// the screen's title, and at most two icon actions (Search, Compose). PushFrame is the level itself:
// it slides in from the right when you go deeper and reverses when you come back, on
// --motion-drawer (280 ms, --ease-out). The slide is a CSS entrance with backwards fill, so nothing
// waits for an animationend that reduced motion (no animation at all) would never send.
//
// PST-T-17.8: on Settings, Admin and the other pushed screens the bar is a large-title bar
// (`largeTitle`): empty, with no hairline, until the page's own h1 scrolls up under it (largeTitle.ts),
// and its trailing slot carries an action the page hands up (barSlot.tsx, documented there).
import './mobile.css';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useBarSlotAction, type BarSlot } from './barSlot';
import { observeLargeTitle } from './largeTitle';
import { pushDirection, type ContextParent, type PushDirection } from './push';

function BackChevron() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

export interface ContextBarProps {
  /** Back: the parent's route and name. Absent at the root. */
  back?: ContextParent | null | undefined;
  /** The screen's name. */
  title?: string | undefined;
  /**
   * True when the screen carries the same words as its own heading (an h1/h2 below the bar): the
   * bar's copy is then hidden from assistive tech, so a screen reader hears the title once.
   */
  titleIsDuplicate?: boolean | undefined;
  /** At most two IconButtons: Search and Compose. */
  actions?: ReactNode;
  /**
   * A large-title screen (PST-T-15.8, the canvas's PhoneInbox): the screen's own heading sits right
   * under the bar, so the bar draws no hairline and no title of its own.
   */
  flush?: boolean | undefined;
  /**
   * The iOS large-title pattern (PST-T-17.8): the title stays empty, and the bar flush, until the
   * page's PageHeader h1 (`.d3-ph__title`, found in the bar's own push frame) has scrolled up under
   * the bar. A screen without one shows the title from the start.
   */
  largeTitle?: boolean | undefined;
  /** The trailing slot a page fills with `useContextBarAction` (barSlot.tsx); drawn after `actions`. */
  slot?: BarSlot | null | undefined;
}

/** Whether the bar shows its title: always, unless it is a large-title bar whose page h1 still shows. */
function useShowTitle(largeTitle: boolean, bar: RefObject<HTMLDivElement | null>): boolean {
  // A large-title screen opens with its h1 in view, so the bar starts empty; the layout effect
  // corrects it before the first paint when there is no h1 to defer to.
  const [show, setShow] = useState(!largeTitle);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!largeTitle || el === null) {
      setShow(true);
      return undefined;
    }
    return observeLargeTitle(el, setShow);
  }, [largeTitle, bar]);
  return show;
}

export function ContextBar({ back, title, titleIsDuplicate = true, actions, flush = false, largeTitle = false, slot }: ContextBarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const showTitle = useShowTitle(largeTitle, ref);
  const trailing = useBarSlotAction(slot);
  // While the page's h1 shows under it, a large-title bar is flush: no title, no hairline.
  const titleHidden = largeTitle && !showTitle;
  return (
    <div
      ref={ref}
      className={flush || titleHidden ? 'pr-cbar pr-cbar--flush' : 'pr-cbar'}
      data-testid="context-bar"
      {...(largeTitle ? { 'data-large-title': showTitle ? 'collapsed' : 'expanded' } : {})}
    >
      <div className="pr-cbar__lead">
        {back === null || back === undefined ? null : (
          <RouterLink className="pr-cbar__back" to={back.to}>
            <BackChevron />
            <span className="pr-cbar__back-label">{back.label}</span>
          </RouterLink>
        )}
      </div>
      <p className="pr-cbar__title" {...(titleIsDuplicate ? { 'aria-hidden': true } : {})}>
        {showTitle ? (title ?? '') : ''}
      </p>
      <div className="pr-cbar__actions">
        {actions}
        {trailing}
      </div>
    </div>
  );
}

/**
 * The direction the screen now showing arrived from. It changes only when `screen` does — the
 * value is held in state across the renders in between, so an animation already running is never
 * cut short by a re-render ("storing information from previous renders", React's own pattern).
 */
export function usePushDirection(screen: string, depth: number): PushDirection {
  const [shown, setShown] = useState<{ screen: string; depth: number; direction: PushDirection }>({ screen, depth, direction: 'none' });
  if (shown.screen !== screen || shown.depth !== depth) {
    // A new screen takes its direction from the depth it left; a deeper move INSIDE one screen (the
    // mail view pushes its own levels) only records the depth, for the next screen to compare with.
    const next = { screen, depth, direction: shown.screen === screen ? shown.direction : pushDirection(shown.depth, depth) };
    setShown(next);
    return next.direction;
  }
  return shown.direction;
}

/** One push level. Key it by the screen, so a new screen mounts (and so enters) on its own. */
export function PushFrame({ direction, className, children }: { direction: PushDirection; className?: string | undefined; children: ReactNode }) {
  return (
    <div className={className === undefined ? 'pr-push' : `pr-push ${className}`} data-push={direction}>
      {children}
    </div>
  );
}
