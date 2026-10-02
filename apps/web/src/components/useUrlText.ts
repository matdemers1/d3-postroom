import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

// A text field whose value is also in the URL — Contacts' ?q=, the Outbound queue's ?domain=
// (PST-T-17.18, PST-REQ-198).
//
// The field cannot take its value straight from the URL. React Router 7 commits every location
// change inside startTransition, and React puts a controlled input back to its last committed value
// as soon as the change handler returns; until the transition lands, the input holds the old text.
// A second key typed in that window lands on the old text and the first is lost: "g" then "s" in
// Contacts' search left "s". So the text lives in state, which updates with the keystroke, and is
// written to the URL as well. The URL catches up later; its changes are either echoes of what the
// field wrote (ignored, in order) or come from somewhere else — Back, a link, a reload — and those
// replace the text.

export interface UrlText {
  /** What the field shows. */
  text: string;
  /** Values written to the URL that it has not shown yet, oldest first. */
  inFlight: readonly string[];
}

export function urlTextInit(url: string): UrlText {
  return { text: url, inFlight: [] };
}

/** The field changed. `write` is false when the URL already holds (or is about to hold) `value`. */
export function urlTextTyped(state: UrlText, value: string, url: string): { state: UrlText; write: boolean } {
  const last = state.inFlight.at(-1) ?? url;
  if (value === last) return { state: { ...state, text: value }, write: false };
  return { state: { text: value, inFlight: [...state.inFlight, value] }, write: true };
}

/**
 * The location changed and the URL now holds `url`. A transition can skip values, so an echo
 * settles every write up to it; anything else is someone else's change, and the URL wins.
 */
export function urlTextArrived(state: UrlText, url: string): UrlText {
  const echo = state.inFlight.indexOf(url);
  if (echo !== -1) return { text: state.text, inFlight: state.inFlight.slice(echo + 1) };
  return urlTextInit(url);
}

/**
 * The field's text and its change handler. `url` is the value the URL holds now; `write` puts a new
 * value in the URL (with replace, so typing does not fill the Back stack).
 */
export function useUrlText(url: string, write: (value: string) => void): [string, (value: string) => void] {
  // Keyed on the location rather than on `url`: a round trip ("g", then backspace) leaves `url`
  // where it started, and its echo must still settle the writes in flight.
  const { key } = useLocation();
  const model = useRef(urlTextInit(url));
  const [text, setText] = useState(url);
  useEffect(() => {
    model.current = urlTextArrived(model.current, url);
    setText(model.current.text);
  }, [key, url]);
  const onChange = (value: string): void => {
    const next = urlTextTyped(model.current, value, url);
    model.current = next.state;
    setText(value);
    if (next.write) write(value);
  };
  return [text, onChange];
}
