// parseInvite against fixtures shaped like real Google Calendar and Outlook REQUEST/CANCEL bodies
// (PST-T-8.4, PST-REQ-134): folded lines, CRLF, VTIMEZONE blocks and X- properties all parse.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReply, ImipError, parseInvite, replyBlockReason } from '../../src/index.js';

const fixtures = join(import.meta.dirname, '..', 'fixtures');
const load = (name: string): Buffer => readFileSync(join(fixtures, name));

describe('parseInvite (PST-T-8.4)', () => {
  it('parses a Google Calendar REQUEST: organizer, attendees, folded DESCRIPTION, VTIMEZONE-resolved times', () => {
    const invite = parseInvite(load('google-request.ics'));
    expect(invite.method).toBe('REQUEST');
    expect(invite.uid).toBe('1234567890abcdef@google.com');
    expect(invite.sequence).toBe(0);
    expect(invite.summary).toBe('Quarterly Planning Sync');
    expect(invite.location).toBe('Conference Room 4B');
    expect(invite.allDay).toBe(false);
    // America/New_York is UTC-4 in October (EDT): 14:00 local -> 18:00Z.
    expect(invite.start).toBe('2026-10-05T18:00:00.000Z');
    expect(invite.end).toBe('2026-10-05T19:00:00.000Z');
    expect(invite.organizer).toEqual({ email: 'priya@example.com', cn: 'Priya Patel' });
    expect(invite.attendees).toHaveLength(2);
    expect(invite.attendees[1]).toMatchObject({ email: 'reader@d3cloud.io', cn: 'Reader Person', role: 'REQ-PARTICIPANT', rsvp: true, partstat: 'NEEDS-ACTION' });
    expect(invite.recurrenceId).toBeNull();
  });

  it('parses an Outlook REQUEST: a named (non-IANA) TZID resolved through its own VTIMEZONE', () => {
    const invite = parseInvite(load('outlook-request.ics'));
    expect(invite.method).toBe('REQUEST');
    expect(invite.summary).toBe('Budget Review');
    expect(invite.organizer).toEqual({ email: 'morgan.lee@example.com', cn: 'Morgan Lee' });
    // Eastern Standard Time's VTIMEZONE puts October in daylight (UTC-4): 09:30 -> 13:30Z.
    expect(invite.start).toBe('2026-10-12T13:30:00.000Z');
    expect(invite.end).toBe('2026-10-12T14:30:00.000Z');
    expect(invite.attendees.map((a) => a.email)).toEqual(['reader@d3cloud.io', 'morgan.lee@example.com']);
    expect(invite.attendees[1]).toMatchObject({ role: 'CHAIR', partstat: 'ACCEPTED', rsvp: false });
  });

  it('parses a CANCEL', () => {
    const invite = parseInvite(load('google-cancel.ics'));
    expect(invite.method).toBe('CANCEL');
    expect(invite.uid).toBe('1234567890abcdef@google.com');
    expect(invite.sequence).toBe(1);
  });

  it('parses a recurring invite’s single-instance exception (RECURRENCE-ID)', () => {
    const invite = parseInvite(load('recurring-exception-request.ics'));
    expect(invite.method).toBe('REQUEST');
    expect(invite.recurrenceId).toBe('20261103T093000');
    expect(invite.summary).toBe('Weekly Standup (moved)');
  });

  it('refuses a calendar object with no METHOD', () => {
    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTAMP:20260101T000000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    expect(() => parseInvite(ics)).toThrow(ImipError);
  });

  it('refuses an unknown METHOD and a calendar object with no VEVENT', () => {
    expect(() => parseInvite('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:BOGUS\r\nEND:VCALENDAR\r\n')).toThrow(ImipError);
    expect(() => parseInvite('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n')).toThrow(ImipError);
  });

  it('an all-day invite reports a plain date, not an instant', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:allday@example.com',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;VALUE=DATE:20261225',
      'DTEND;VALUE=DATE:20261226',
      'ORGANIZER:mailto:org@example.com',
      'ATTENDEE:mailto:reader@d3cloud.io',
      'SUMMARY:Holiday',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const invite = parseInvite(ics);
    expect(invite.allDay).toBe(true);
    expect(invite.start).toBe('20261225');
    expect(invite.end).toBe('20261226');
  });

  describe('an ORGANIZER that is not one valid mailbox is not replyable (verifier PoC)', () => {
    const withOrganizer = (organizerLine: string | null): string =>
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'METHOD:REQUEST',
        'BEGIN:VEVENT',
        'UID:poc@example.com',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20261005T180000Z',
        ...(organizerLine === null ? [] : [organizerLine]),
        'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:reader@d3cloud.io',
        'SUMMARY:Totally legit',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n');

    const hostile = [
      'ORGANIZER;CN=Priya Patel:mailto:evil%40attacker.example%0d%0aRCPT%20TO:%3cvictim%40external.example%3e',
      'ORGANIZER;CN=Priya Patel:mailto:evil@attacker.example%0aBcc:victim@external.example',
      'ORGANIZER;CN=Priya Patel:mailto:evil@attacker.example%0d',
      'ORGANIZER;CN=Priya Patel:mailto:a@example.com,b@example.com',
      'ORGANIZER;CN=Priya Patel:mailto:%3Cevil@attacker.example%3E',
      'ORGANIZER;CN=Priya Patel:https://attacker.example/',
    ];

    it.each(hostile)('%s', (line) => {
      const invite = parseInvite(withOrganizer(line));
      expect(invite.organizer.email).toBeNull();
      expect(invite.organizer.cn).toBe('Priya Patel');
      expect(invite.organizerStatus).toBe('invalid');
      expect(replyBlockReason(invite)).toBe('Can’t reply: the organizer address is invalid.');
      expect(() => buildReply(invite, ['reader@d3cloud.io'], 'ACCEPTED', new Date())).toThrow(/organizer address is invalid/);
    });

    it('a missing ORGANIZER says so, and a valid one is replyable', () => {
      const missing = parseInvite(withOrganizer(null));
      expect(missing.organizerStatus).toBe('missing');
      expect(replyBlockReason(missing)).toMatch(/names no organizer/);
      const ok = parseInvite(withOrganizer('ORGANIZER;CN=Priya:mailto:priya@example.com'));
      expect(ok.organizerStatus).toBe('valid');
      expect(replyBlockReason(ok)).toBeNull();
    });

    it('an ATTENDEE with an injected address is dropped, never matched', () => {
      const ics = withOrganizer('ORGANIZER:mailto:priya@example.com').replace(
        'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:reader@d3cloud.io',
        'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:reader@d3cloud.io%0d%0aRCPT%20TO:%3cvictim@external.example%3e',
      );
      expect(parseInvite(ics).attendees).toEqual([]);
    });
  });
});
