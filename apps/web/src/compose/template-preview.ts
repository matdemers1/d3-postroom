// Templates (PST-T-17.10, PST-REQ-144): a saved reply's row says what it says — its subject when it
// has one, then the start of its body on one line — rather than "No subject". Pure, for the tests.
import type { TemplateJson } from './api';

/** The body on one line, cut at a word near `max` characters with an ellipsis. */
export function bodyPreview(body: string, max = 60): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

/** The row's description: "Subject · body preview", or just the preview when there is no subject. */
export function templateDescription(template: Pick<TemplateJson, 'subject' | 'body'>): string {
  const subject = (template.subject ?? '').trim();
  const preview = bodyPreview(template.body);
  if (subject === '') return preview;
  return preview === '' ? subject : `${subject} · ${preview}`;
}
