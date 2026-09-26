// Who may cancel a stored event (PST-T-8.4, PST-REQ-134): the organizer of record, authenticated for
// their domain, with a SEQUENCE not older than the stored one. Pure; the integration suite drives
// the route end to end.
import { describe, expect, it } from 'vitest';
import { cancelEligibility, type CancelInput } from '../../src/invites/cancel.js';
import { storedOrganizer, storedSequence } from '../../src/invites/event.js';
import { parseICalendar } from '@postroom/ical';

const genuine: CancelInput = {
  cancelOrganizer: 'Priya@Example.com',
  cancelSequence: 1,
  storedOrganizer: 'priya@example.com',
  storedSequence: 0,
  auth: { dmarc: { result: 'pass', fromDomain: 'example.com' }, dkim: [{ result: 'pass', domain: 'example.com' }] },
  fromAddress: 'priya@example.com',
};

describe('cancelEligibility (PST-T-8.4)', () => {
  it('honours the genuine organizer’s authenticated CANCEL (case-insensitive organizer match)', () => {
    expect(cancelEligibility(genuine)).toEqual({ ok: true });
    expect(cancelEligibility({ ...genuine, cancelSequence: 0 })).toEqual({ ok: true });
  });

  it('refuses a CANCEL from a different organizer, or when either organizer is unknown', () => {
    expect(cancelEligibility({ ...genuine, cancelOrganizer: 'mallory@example.com' })).toMatchObject({ ok: false, status: 403, error: 'cancel_organizer_mismatch' });
    expect(cancelEligibility({ ...genuine, cancelOrganizer: null })).toMatchObject({ ok: false, error: 'cancel_organizer_mismatch' });
    expect(cancelEligibility({ ...genuine, storedOrganizer: null })).toMatchObject({ ok: false, error: 'cancel_organizer_mismatch' });
  });

  it('refuses a spoofed CANCEL: DMARC fail, no verdict, or a From domain that is not the organizer’s', () => {
    expect(cancelEligibility({ ...genuine, auth: { dmarc: { result: 'fail', fromDomain: 'example.com' }, dkim: [{ result: 'fail', domain: 'example.com' }] } })).toMatchObject({
      ok: false,
      status: 403,
      error: 'cancel_unauthenticated',
    });
    expect(cancelEligibility({ ...genuine, auth: null })).toMatchObject({ error: 'cancel_unauthenticated' });
    expect(cancelEligibility({ ...genuine, auth: {} })).toMatchObject({ error: 'cancel_unauthenticated' });
    // DMARC passed — for the attacker's own domain.
    expect(cancelEligibility({ ...genuine, auth: { dmarc: { result: 'pass', fromDomain: 'attacker.example' } }, fromAddress: 'x@attacker.example' })).toMatchObject({ error: 'cancel_unauthenticated' });
    // DKIM passed, but signed by a third party.
    expect(cancelEligibility({ ...genuine, auth: { dmarc: { result: 'none', fromDomain: 'example.com' }, dkim: [{ result: 'pass', domain: 'mailer.example' }] } })).toMatchObject({ error: 'cancel_unauthenticated' });
  });

  it('accepts a From domain equal to the organizer’s with a DKIM pass by that domain when DMARC did not pass', () => {
    expect(cancelEligibility({ ...genuine, auth: { dmarc: { result: 'none', fromDomain: 'example.com' }, dkim: [{ result: 'pass', domain: 'Example.com' }] } })).toEqual({ ok: true });
    // No evaluated fromDomain: the denormalised From address stands in.
    expect(cancelEligibility({ ...genuine, auth: { dmarc: { result: 'pass' } }, fromAddress: 'priya@example.com' })).toEqual({ ok: true });
    expect(cancelEligibility({ ...genuine, auth: { dmarc: { result: 'pass' } }, fromAddress: 'x@attacker.example' })).toMatchObject({ error: 'cancel_unauthenticated' });
  });

  it('refuses a CANCEL older than the stored event', () => {
    expect(cancelEligibility({ ...genuine, cancelSequence: 1, storedSequence: 2 })).toMatchObject({ ok: false, status: 409, error: 'cancel_stale' });
  });

  it('reads the stored event’s organizer and sequence', () => {
    const cal = parseICalendar(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u', 'ORGANIZER;CN=P:mailto:Priya@Example.com', 'SEQUENCE:3', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'));
    expect(storedOrganizer(cal)).toBe('priya@example.com');
    expect(storedSequence(cal)).toBe(3);
    const bare = parseICalendar(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u', 'ORGANIZER:mailto:evil@attacker.example%0d%0a', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'));
    expect(storedOrganizer(bare)).toBeNull();
    expect(storedSequence(bare)).toBe(0);
  });
});
