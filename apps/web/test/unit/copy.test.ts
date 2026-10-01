// PST-T-16.22 (PST-DA-058; PST-REQ-136, PST-REQ-079): the copy this task settled, one assertion per
// string. Pure helpers are called; JSX strings are checked in the source they live in, the way
// copy-consistency.test.ts scans it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRecurrenceForm, repeatHelp, timeZoneInWords } from '../../src/calendar/recurrence';

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

describe('time zone in words', () => {
  it('names a zone by its longGeneric name, not its IANA id', () => {
    const at = new Date(Date.UTC(2031, 0, 15, 12));
    expect(timeZoneInWords('America/New_York', at)).toBe('Eastern Time');
    expect(timeZoneInWords('America/Los_Angeles', at)).toBe('Pacific Time');
    expect(timeZoneInWords('America/New_York', at)).not.toContain('/');
  });

  it('falls back to the id when the runtime cannot name the zone', () => {
    expect(timeZoneInWords('Not/AZone')).toBe('Not/AZone');
  });

  it('is what the editor renders', () => {
    expect(read('calendar/EventEditor.tsx')).toContain('Times are in {timeZoneInWords(form.timezone)}.');
  });
});

describe('Repeat helper', () => {
  it('is absent when the event does not repeat', () => {
    expect(repeatHelp(defaultRecurrenceForm('2031-01-13'))).toBeNull();
  });

  it('describes an actual rule', () => {
    expect(repeatHelp({ ...defaultRecurrenceForm('2031-01-13'), repeat: 'DAILY' })).toBe('Every day');
  });
});

describe('event editor buttons and discard confirmation', () => {
  const source = read('calendar/EventEditor.tsx');
  it("says 'Create event' for a new event and 'Save event' for an existing one", () => {
    expect(source).toContain("{target?.kind === 'new' ? 'Create event' : 'Save event'}");
  });
  it('confirms before discarding unsaved changes', () => {
    expect(source).toContain('title="Discard changes to this event?"');
    expect(source).toContain('Keep editing');
    expect(source).toMatch(/>\s*Discard\s*</);
  });
});

describe('Templates and Bcc help', () => {
  it('Templates has the new description', () => {
    expect(read('compose/TemplatesScreen.tsx')).toContain('description="Saved replies you can drop into any message."');
  });
  it('Templates helper shows ;sig in <code>', () => {
    expect(read('compose/TemplatesScreen.tsx')).toMatch(/Type <code>;sig<\/code> in a message to insert the template whose shortcut is sig\./);
  });
  it("Bcc help reads 'Other recipients won’t see these addresses.'", () => {
    expect(read('mail/Composer.tsx')).toContain('content="Other recipients won’t see these addresses."');
  });
});
