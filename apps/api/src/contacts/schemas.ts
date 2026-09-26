// The zod schemas of the contacts API (PST-T-8.5, PST-REQ-137, PST-REQ-138). They validate every
// request, and the OpenAPI document is generated from these same objects (PST-REQ-085).
import { z } from 'zod';

const Uuid = z.uuid();
const Line = z.string().max(500).regex(/^[^\r\n]*$/, 'no line breaks');
const Type = z
  .string()
  .max(40)
  .regex(/^[A-Za-z0-9-]*$/, 'a TYPE such as work, home or cell')
  .nullable()
  .default(null);
const ResourceName = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => s !== '.' && s !== '..' && !s.includes('/'), 'a resource name');

export const ContactEmailBody = z.object({ address: z.string().trim().min(3).max(320).regex(/^[^\s@<>]+@[^\s@<>]+$/, 'an e-mail address'), type: Type });
export const ContactTelBody = z.object({ value: z.string().trim().min(1).max(100).regex(/^[^\r\n]*$/, 'no line breaks'), type: Type });

export const ContactRequest = z.object({
  fn: Line.default('').describe('The name as shown; derived from given/family, org or the first e-mail when blank.'),
  given: Line.default(''),
  family: Line.default(''),
  emails: z.array(ContactEmailBody).max(50).default([]),
  tels: z.array(ContactTelBody).max(50).default([]),
  org: Line.default(''),
  note: z.string().max(10_000).default(''),
});

export const ContactListQuery = z.object({
  q: z.string().trim().max(200).optional().describe('Matches name, e-mail, phone or organisation (case-insensitive).'),
  addressBookId: Uuid.optional(),
});

export const LookupQuery = z.object({ address: z.string().trim().min(3).max(320) });

export const AddressBookParams = z.object({ addressBookId: Uuid });
export const CardParams = z.object({ addressBookId: Uuid, name: ResourceName });

// Responses

export const AddressBook = z.object({ id: Uuid, displayName: z.string(), slug: z.string(), count: z.number().int() });
export const AddressBookList = z.object({ addressBooks: z.array(AddressBook) });

const ContactEmail = z.object({ address: z.string(), type: z.string().nullable() });
const ContactTel = z.object({ value: z.string(), type: z.string().nullable() });

export const ContactSummary = z.object({
  addressBookId: Uuid,
  name: z.string().describe('The card’s resource name in its address book.'),
  etag: z.string(),
  uid: z.string(),
  displayName: z.string(),
  emails: z.array(z.string()),
  org: z.string(),
  hasPhoto: z.boolean(),
});
export const ContactList = z.object({ contacts: z.array(ContactSummary), truncated: z.boolean() });

export const Contact = z.object({
  addressBookId: Uuid,
  name: z.string(),
  etag: z.string(),
  uid: z.string(),
  displayName: z.string(),
  fn: z.string(),
  given: z.string(),
  family: z.string(),
  emails: z.array(ContactEmail),
  tels: z.array(ContactTel),
  org: z.string(),
  note: z.string(),
  hasPhoto: z.boolean().describe('The card carries a PHOTO; kept on edit, not editable here.'),
});

export const ContactLookup = z.object({
  contact: z.object({ addressBookId: Uuid, name: z.string(), displayName: z.string() }).nullable(),
});

export const ContactSaved = z.object({ addressBookId: Uuid, name: z.string(), uid: z.string(), etag: z.string() });

export type AddressBookJson = z.infer<typeof AddressBook>;
export type ContactSummaryJson = z.infer<typeof ContactSummary>;
export type ContactJson = z.infer<typeof Contact>;
export type ContactSavedJson = z.infer<typeof ContactSaved>;
