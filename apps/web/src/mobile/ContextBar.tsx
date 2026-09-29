// PST-T-14.8 (PST-REQ-155, PST-REQ-192, PST-REQ-193, PST-ADR-011): the phone's two pieces of
// chrome. ContextBar is the sticky bar at the top of every push level — Back with the parent's name,
// the screen's title, and at most two icon actions (Search, Compose). PushFrame is the level itself:
// it slides in from the right when you go deeper and reverses when you come back, on
// --motion-drawer (280 ms, --ease-out). The slide is a CSS entrance with backwards fill, so nothing
// waits for an animationend that reduced motion (no animation at all) would never send.
import './mobile.css';
import { useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
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
}

export function ContextBar({ back, title, titleIsDuplicate = true, actions }: ContextBarProps) {
  return (
    <div className="pr-cbar" data-testid="context-bar">
      <div className="pr-cbar__lead">
        {back === null || back === undefined ? null : (
          <RouterLink className="pr-cbar__back" to={back.to}>
            <BackChevron />
            <span className="pr-cbar__back-label">{back.label}</span>
          </RouterLink>
        )}
      </div>
      <p className="pr-cbar__title" {...(titleIsDuplicate ? { 'aria-hidden': true } : {})}>
        {title ?? ''}
      </p>
      <div className="pr-cbar__actions">{actions}</div>
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
