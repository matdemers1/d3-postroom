import { Button, Menu, MenuContent, MenuItem, MenuTrigger } from '@d3cloud/ui';
import type { WizardStep, WizardView } from '../../api';
import { doneLabel, positionLabel, type ShownStep, stepItems, stepName } from './wizard-steps';
import './wizard.css';

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
      <path d="M2.5 6.25 5 8.75l4.5-5.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
      <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Where the operator is in setup (admin critique 2.9 #1, #5). From `sm` up: an ordered list of five
 * numbered circles joined by a hairline — done shows a ✓, the step on screen is the accent circle and
 * carries `aria-current="step"`, a step not reached yet is a hairline circle with a muted (never
 * faint) label and `aria-disabled`. On a phone: one line, "Step 3 of 5 · DNS records", over a
 * five-segment bar; the line opens a menu of the steps that can be opened.
 */
export function WizardSteps({
  view,
  current,
  phone,
  onPick,
}: {
  view: WizardView;
  current: WizardStep;
  phone: boolean;
  onPick: (step: ShownStep) => void;
}) {
  const items = stepItems(view, current);
  const count = doneLabel(view);

  if (phone) {
    return (
      <nav aria-label="Setup steps" className="pr-steps pr-steps--phone">
        <div className="pr-steps__head">
          <Menu>
            <MenuTrigger>
              <Button variant="ghost" className="pr-steps__trigger" aria-label={`${positionLabel(current)}. Choose a step`}>
                <span>{positionLabel(current)}</span>
                <ChevronGlyph />
              </Button>
            </MenuTrigger>
            <MenuContent align="start">
              {items
                .filter((item) => item.reachable)
                .map((item) => (
                  <MenuItem
                    key={item.step}
                    {...(item.done ? { icon: <CheckGlyph /> } : {})}
                    onSelect={() => {
                      onPick(item.step);
                    }}
                  >
                    {stepName(item)}
                  </MenuItem>
                ))}
            </MenuContent>
          </Menu>
          <p className="pr-steps__count">{count}</p>
        </div>
        <div className="pr-steps__bar" aria-hidden="true">
          {items.map((item) => (
            <span key={item.step} className={`pr-steps__seg${item.done || item.current ? ' pr-steps__seg--on' : ''}`} />
          ))}
        </div>
      </nav>
    );
  }

  return (
    <nav aria-label="Setup steps" className="pr-steps">
      <p className="pr-steps__count">{count}</p>
      <ol className="pr-steps__list">
        {items.map((item) => (
          <li key={item.step} className={`pr-steps__item pr-steps__item--${item.state}${item.done ? ' pr-steps__item--complete' : ''}`}>
            <button
              type="button"
              className="pr-steps__btn"
              aria-current={item.current ? 'step' : undefined}
              aria-disabled={item.reachable ? undefined : true}
              aria-label={stepName(item)}
              onClick={() => {
                if (item.reachable && !item.current) onPick(item.step);
              }}
            >
              <span className="pr-steps__mark" aria-hidden="true">
                {item.done ? <CheckGlyph /> : String(item.number)}
              </span>
              <span className="pr-steps__label" aria-hidden="true">
                {item.label}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
