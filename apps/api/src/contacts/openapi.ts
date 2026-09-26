// The contacts routes in the OpenAPI document (PST-REQ-085), generated from the same zod objects
// the routes validate with (schemas.ts). Spread into ROUTES/COMPONENTS by src/openapi/document.ts.
import type { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import * as C from './schemas.js';

export const CONTACTS_COMPONENTS: Record<string, z.ZodType> = {
  AddressBook: C.AddressBook,
  AddressBookList: C.AddressBookList,
  ContactSummary: C.ContactSummary,
  ContactList: C.ContactList,
  Contact: C.Contact,
  ContactLookup: C.ContactLookup,
  ContactSaved: C.ContactSaved,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];
const IF_MATCH = { name: 'if-match', required: true, description: 'The card’s ETag, as read.' };
const ETAG = { ETag: { description: 'The card’s entity tag, quoted.', schema: { type: 'string' } } };
const COMMON = { '400': err('The request failed validation.'), '401': err('No session.'), '404': err('No such address book or card of the caller.'), '503': err('POSTROOM_KEK is not set.') };
const WRITE = { ...COMMON, '403': err('Missing CSRF header.'), '412': err('If-Match does not match: the card changed since it was read.'), '428': err('If-Match is missing.') };

export const CONTACTS_ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/contacts/address-books',
    operationId: 'listAddressBooks',
    tag: 'Contacts',
    summary: 'The caller’s address books (the same collections CardDAV serves), with card counts.',
    responses: { '200': { description: 'Address books.', schema: 'AddressBookList' }, '401': COMMON['401'], '503': COMMON['503'] },
  },
  {
    method: 'get',
    path: '/api/contacts',
    operationId: 'listContacts',
    tag: 'Contacts',
    summary: 'Cards across the caller’s address books, by name, optionally filtered.',
    query: C.ContactListQuery,
    responses: { '200': { description: 'Contacts.', schema: 'ContactList' }, '400': COMMON['400'], '401': COMMON['401'], '503': COMMON['503'] },
  },
  {
    method: 'get',
    path: '/api/contacts/lookup',
    operationId: 'lookupContact',
    tag: 'Contacts',
    summary: 'The card carrying an e-mail address, if any (the sender profile’s link).',
    query: C.LookupQuery,
    responses: { '200': { description: 'The contact, or null.', schema: 'ContactLookup' }, '400': COMMON['400'], '401': COMMON['401'], '503': COMMON['503'] },
  },
  {
    method: 'post',
    path: '/api/contacts/address-books/{addressBookId}/cards',
    operationId: 'createContact',
    tag: 'Contacts',
    summary: 'Create a card (vCard 3.0) through the DAV store; a CardDAV client’s next sync pulls it.',
    params: C.AddressBookParams,
    body: C.ContactRequest,
    headers: CSRF,
    responses: { '201': { description: 'Created.', schema: 'ContactSaved', headers: ETAG }, ...COMMON, '403': err('Missing CSRF header.'), '413': err('Larger than a vCard may be.'), '507': err('The address book is full.') },
  },
  {
    method: 'get',
    path: '/api/contacts/address-books/{addressBookId}/cards/{name}',
    operationId: 'getContact',
    tag: 'Contacts',
    summary: 'One card as the form edits it.',
    params: C.CardParams,
    responses: { '200': { description: 'The contact.', schema: 'Contact', headers: ETAG }, ...COMMON, '409': err('The stored card cannot be parsed.') },
  },
  {
    method: 'put',
    path: '/api/contacts/address-books/{addressBookId}/cards/{name}',
    operationId: 'updateContact',
    tag: 'Contacts',
    summary: 'Edit a card: FN, N, EMAIL, TEL, ORG and NOTE are replaced; everything else on the card is kept.',
    params: C.CardParams,
    body: C.ContactRequest,
    headers: [...CSRF, IF_MATCH],
    responses: { '200': { description: 'Saved.', schema: 'ContactSaved', headers: ETAG }, ...WRITE, '413': err('Larger than a vCard may be.') },
  },
  {
    method: 'delete',
    path: '/api/contacts/address-books/{addressBookId}/cards/{name}',
    operationId: 'deleteContact',
    tag: 'Contacts',
    summary: 'Delete a card.',
    params: C.CardParams,
    headers: [...CSRF, IF_MATCH],
    responses: { '204': { description: 'Deleted.' }, ...WRITE },
  },
];
