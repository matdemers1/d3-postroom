// The zod schemas of the invites API (PST-T-8.4, PST-REQ-134). They validate every request, and the
// OpenAPI document is generated from these same objects (PST-REQ-085).
import { z } from 'zod';
import { IMIP_METHODS } from '@postroom/imip';

export const IdParams = z.object({ id: z.uuid() });

export const RespondBody = z.object({ partstat: z.enum(['ACCEPTED', 'TENTATIVE', 'DECLINED']) });

export const InviteOrganizer = z.object({ email: z.string().nullable(), cn: z.string().nullable() });
export const InviteAttendee = z.object({ email: z.string(), cn: z.string().nullable(), role: z.string().nullable(), rsvp: z.boolean(), partstat: z.string() });

export const InviteView = z.object({
  method: z.enum(IMIP_METHODS),
  uid: z.string(),
  sequence: z.number(),
  summary: z.string(),
  location: z.string(),
  allDay: z.boolean(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  organizer: InviteOrganizer,
  attendees: z.array(InviteAttendee),
  recurrenceId: z.string().nullable(),
  /** The caller's own current PARTSTAT, if one of the addresses is invited; null otherwise. */
  you: z.object({ email: z.string(), partstat: z.string() }).nullable(),
  /** True for a CANCEL, or a REQUEST whose stored calendar event was itself cancelled. */
  cancelled: z.boolean(),
  /** True when this UID already has an object in the caller's default calendar. */
  inCalendar: z.boolean(),
});

export const InviteRespondResult = z.object({ ok: z.literal(true), partstat: z.enum(['ACCEPTED', 'TENTATIVE', 'DECLINED']), calendarName: z.string() });
export const InviteRemoveResult = z.object({ ok: z.literal(true), removed: z.boolean() });

export type InviteViewJson = z.infer<typeof InviteView>;
export type InviteRespondResultJson = z.infer<typeof InviteRespondResult>;
export type InviteRemoveResultJson = z.infer<typeof InviteRemoveResult>;
