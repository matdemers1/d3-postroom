// Pure invite-card logic (PST-T-8.4, PST-REQ-134): run in Node, without @d3cloud/ui.
import { describe, expect, it } from 'vitest';
import type { InviteView } from '../../src/api';
import {
  attendeeCountLabel,
  inviteWhen,
  isCurrentAnswer,
  offersRemoval,
  offersResponse,
  organizerLabel,
  partstatLabel,
  replyBlockedReason,
  replyTarget,
  replyTargetNote,
  responseAnnouncement,
} from '../../src/invites/view';

const base: InviteView = {
  method: 'REQUEST',
  uid: 'evt-1@example.com',
  sequence: 0,
  summary: 'Quarterly Planning Sync',
  location: 'Room 4B',
  allDay: false,
  start: '2026-10-05T18:00:00.000Z',
  end: '2026-10-05T19:00:00.000Z',
  organizer: { email: 'priya@example.com', cn: 'Priya Patel' },
  attendees: [
    { email: 'priya@example.com', cn: 'Priya Patel', role: 'CHAIR', rsvp: false, partstat: 'ACCEPTED' },
    { email: 'reader@d3cloud.io', cn: 'Reader', role: 'REQ-PARTICIPANT', rsvp: true, partstat: 'NEEDS-ACTION' },
  ],
  recurrenceId: null,
  you: { email: 'reader@d3cloud.io', partstat: 'NEEDS-ACTION' },
  cancelled: false,
  inCalendar: false,
};

describe('invite view logic (PST-T-8.4)', () => {
  it('labels a PARTSTAT', () => {
    expect(partstatLabel('ACCEPTED')).toBe('Accepted');
    expect(partstatLabel('DECLINED')).toBe('Declined');
    expect(partstatLabel('TENTATIVE')).toBe('Maybe');
    expect(partstatLabel('NEEDS-ACTION')).toBe('Not yet answered');
    expect(partstatLabel(undefined)).toBe('Not yet answered');
    expect(partstatLabel('X-CUSTOM')).toBe('X-CUSTOM');
  });

  it('shows a local date/time range for a timed event', () => {
    const when = inviteWhen(base, 'en-US');
    expect(when).toContain('–');
    expect(when.length).toBeGreaterThan(0);
  });

  it('shows a plain date, or a range, for an all-day event', () => {
    expect(inviteWhen({ allDay: true, start: '20261225', end: '20261226' }, 'en-US')).toBe('Dec 25, 2026');
    expect(inviteWhen({ allDay: true, start: '20261225', end: '20261228' }, 'en-US')).toBe('Dec 25, 2026 – Dec 27, 2026');
    expect(inviteWhen({ allDay: false, start: null, end: null })).toBe('');
  });

  it('names the organizer by CN AND their actual address, so the reader sees where a reply goes', () => {
    expect(organizerLabel(base)).toBe('Priya Patel <priya@example.com>');
    expect(organizerLabel({ organizer: { email: 'x@example.com', cn: null } })).toBe('x@example.com');
    expect(organizerLabel({ organizer: { email: 'x@example.com', cn: 'X@Example.com' } })).toBe('x@example.com');
    // A CN that impersonates someone else still shows the real address beside it.
    expect(organizerLabel({ organizer: { email: 'evil@attacker.example', cn: 'CEO <ceo@d3cloud.io>' } })).toBe('CEO <ceo@d3cloud.io> <evil@attacker.example>');
    expect(organizerLabel({ organizer: { email: null, cn: 'Priya Patel' } })).toBe('Priya Patel (invalid address)');
    expect(organizerLabel({ organizer: { email: null, cn: null } })).toBe('Unknown organizer');
  });

  it('names the reply target, and says why a REQUEST with an invalid organizer cannot be answered', () => {
    expect(replyTarget(base)).toBe('priya@example.com');
    expect(replyTargetNote(base)).toBe('Your reply is sent to priya@example.com.');
    expect(replyBlockedReason(base)).toBeNull();
    const invalid = { ...base, organizer: { email: null, cn: 'Priya Patel' } };
    expect(replyTarget(invalid)).toBeNull();
    expect(replyTargetNote(invalid)).toBe('');
    expect(replyBlockedReason(invalid)).toBe('Can’t reply: the organizer address is invalid.');
    expect(offersResponse(invalid)).toBe(false);
    expect(replyBlockedReason({ ...invalid, method: 'CANCEL', cancelled: true })).toBeNull();
  });

  it('counts attendees without listing them', () => {
    expect(attendeeCountLabel(base)).toBe('2 people');
    expect(attendeeCountLabel({ attendees: base.attendees.slice(0, 1) })).toBe('1 person');
  });

  it('marks the current answer for the pressed button state', () => {
    expect(isCurrentAnswer(base, 'ACCEPTED')).toBe(false);
    expect(isCurrentAnswer({ you: { email: 'r@x', partstat: 'ACCEPTED' } }, 'ACCEPTED')).toBe(true);
    expect(isCurrentAnswer({ you: null }, 'ACCEPTED')).toBe(false);
  });

  it('offers Accept/Maybe/Decline only for a live REQUEST', () => {
    const organizer = base.organizer;
    expect(offersResponse({ method: 'REQUEST', cancelled: false, organizer })).toBe(true);
    expect(offersResponse({ method: 'REQUEST', cancelled: true, organizer })).toBe(false);
    expect(offersResponse({ method: 'CANCEL', cancelled: true, organizer })).toBe(false);
    expect(offersResponse({ method: 'REPLY', cancelled: false, organizer })).toBe(false);
  });

  it('offers Remove from calendar only for a CANCEL', () => {
    expect(offersRemoval({ method: 'CANCEL' })).toBe(true);
    expect(offersRemoval({ method: 'REQUEST' })).toBe(false);
  });

  it('announces the result of a response', () => {
    expect(responseAnnouncement('ACCEPTED')).toBe('Accepted.');
    expect(responseAnnouncement('DECLINED')).toBe('Declined.');
    expect(responseAnnouncement('TENTATIVE')).toBe('Marked maybe.');
    expect(responseAnnouncement('ACCEPTED', 'priya@example.com')).toBe('Accepted. Reply sent to priya@example.com.');
  });
});
