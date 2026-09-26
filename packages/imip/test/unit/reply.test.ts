// buildReply (RFC 5546 §3.2.3, PST-T-8.4, PST-REQ-134): exactly one ATTENDEE (the replier), the
// ORGANIZER/UID/SEQUENCE/RECURRENCE-ID carried through unchanged, and a fast-check property that the
// output always re-parses keeping UID and SEQUENCE.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { getProperties, getProperty, parseICalendar } from '@postroom/ical';
import { buildReply, ImipError, matchAttendee, parseInvite, serializeReply, type ParsedInvite, type Partstat } from '../../src/index.js';

const fixtures = join(import.meta.dirname, '..', 'fixtures');
const load = (name: string): Buffer => readFileSync(join(fixtures, name));
const now = new Date('2026-09-30T12:00:00Z');

describe('buildReply (PST-T-8.4)', () => {
  it('a REPLY carries METHOD:REPLY, the same UID/SEQUENCE, ORGANIZER, and exactly one ATTENDEE with the given PARTSTAT', () => {
    const invite = parseInvite(load('google-request.ics'));
    const reply = buildReply(invite, ['reader@d3cloud.io'], 'ACCEPTED', now);
    expect(getProperty(reply, 'METHOD')?.value).toBe('REPLY');
    const [vevent] = reply.components;
    if (vevent === undefined) throw new Error('no VEVENT');
    expect(getProperty(vevent, 'UID')?.value).toBe(invite.uid);
    expect(getProperty(vevent, 'SEQUENCE')?.value).toBe(String(invite.sequence));
    expect(getProperty(vevent, 'ORGANIZER')?.value).toBe('mailto:priya@example.com');
    const attendees = getProperties(vevent, 'ATTENDEE');
    expect(attendees).toHaveLength(1);
    expect(attendees[0]?.value).toBe('mailto:reader@d3cloud.io');
    expect(attendees[0]?.params['PARTSTAT']).toEqual(['ACCEPTED']);
  });

  it('matches the invited alias case-insensitively, and replies with exactly that address', () => {
    const invite = parseInvite(load('google-request.ics'));
    const attendee = matchAttendee(invite, ['someone.else@example.org', 'READER@D3CLOUD.IO']);
    expect(attendee?.email).toBe('reader@d3cloud.io');
    const reply = buildReply(invite, ['someone.else@example.org', 'READER@D3CLOUD.IO'], 'DECLINED', now);
    const [vevent] = reply.components;
    expect(getProperty(vevent as NonNullable<typeof vevent>, 'ATTENDEE')?.value).toBe('mailto:reader@d3cloud.io');
  });

  it('refuses when none of the account’s addresses is an attendee of the invitation', () => {
    const invite = parseInvite(load('google-request.ics'));
    expect(matchAttendee(invite, ['nobody@example.org'])).toBeNull();
    expect(() => buildReply(invite, ['nobody@example.org'], 'ACCEPTED', now)).toThrow(ImipError);
  });

  it('carries the RECURRENCE-ID for a single-instance reply', () => {
    const invite = parseInvite(load('recurring-exception-request.ics'));
    const reply = buildReply(invite, ['reader@d3cloud.io'], 'TENTATIVE', now);
    const [vevent] = reply.components;
    expect(getProperty(vevent as NonNullable<typeof vevent>, 'RECURRENCE-ID')?.value).toBe('20261103T093000');
  });

  it('the serialised reply re-parses and matches METHOD/UID/PARTSTAT', () => {
    const invite = parseInvite(load('outlook-request.ics'));
    const reply = buildReply(invite, ['reader@d3cloud.io'], 'ACCEPTED', now);
    const text = serializeReply(reply);
    expect(text).toContain('\r\n');
    const parsed = parseICalendar(text);
    expect(getProperty(parsed, 'METHOD')?.value).toBe('REPLY');
    const [vevent] = parsed.components;
    expect(getProperty(vevent as NonNullable<typeof vevent>, 'UID')?.value).toBe(invite.uid);
  });
});

describe('buildReply property: re-parses keeping UID and SEQUENCE (PST-T-8.4)', () => {
  const invites: ParsedInvite[] = ['google-request.ics', 'outlook-request.ics', 'recurring-exception-request.ics'].map((f) => parseInvite(load(f)));
  const partstats: Partstat[] = ['ACCEPTED', 'DECLINED', 'TENTATIVE'];

  it('round-trips for every fixture and every PARTSTAT', () => {
    fc.assert(
      fc.property(fc.constantFrom(...invites), fc.constantFrom(...partstats), (invite, partstat) => {
        const reply = buildReply(invite, ['reader@d3cloud.io'], partstat, now);
        const text = serializeReply(reply);
        const parsed = parseICalendar(text);
        expect(getProperty(parsed, 'METHOD')?.value).toBe('REPLY');
        const [vevent] = parsed.components;
        if (vevent === undefined) throw new Error('no VEVENT');
        expect(getProperty(vevent, 'UID')?.value).toBe(invite.uid);
        expect(getProperty(vevent, 'SEQUENCE')?.value).toBe(String(invite.sequence));
        const attendees = getProperties(vevent, 'ATTENDEE');
        expect(attendees).toHaveLength(1);
        expect(attendees[0]?.params['PARTSTAT']).toEqual([partstat]);
      }),
      { numRuns: 50 },
    );
  });
});
