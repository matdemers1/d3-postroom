// The contacts API (PST-T-8.5, PST-REQ-137, PST-REQ-138). Mounted by app.ts at /api/contacts behind
// a session, the CSRF guard and the audit guard.
//
// Address books and cards are the DAV store's (contacts/dav.ts): a card made or edited here is the
// same encrypted, etagged, sync-token-advancing, audited write an iPhone's PUT is, so the phone's
// next sync pulls it. An edit changes only the fields the form owns and keeps the rest of the card
// (photo, addresses, Apple's labels) as the phone wrote it. Writes to an existing card need
// If-Match with its etag.
//
// GET /lookup answers "is this sender one of my contacts?" for the reading pane's sender link.
import { randomUUID } from 'node:crypto';
import { getAuditContext } from '@postroom/audit';
import { applyContactFields, buildContactCard, contactOf, type Caller, type Collection, type ContactFields, type ContactView, type DavStore, type PutOutcome } from '@postroom/dav-store';
import { getProperty, parseVCard, serializeVCard, textOf, type VCard } from '@postroom/vcard';
import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import { currentSession, handle } from '../auth/middleware.js';
import type { ApiDeps } from '../deps.js';
import { davFor, formatEtag, ifMatchOf, ownCollection } from './dav.js';
import {
  AddressBookParams,
  CardParams,
  ContactListQuery,
  ContactRequest,
  LookupQuery,
  type AddressBookJson,
  type ContactJson,
  type ContactSavedJson,
  type ContactSummaryJson,
} from './schemas.js';

export { contactIndexOf } from './dav.js';

const MAX_LIST = 5000;
const CACHE_ENTRIES = 20_000;

function parse<S extends z.ZodType>(schema: S, value: unknown, res: Response): z.output<S> | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  res.status(400).json({ error: 'invalid_request', message: result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ') });
  return null;
}

interface Parsed {
  readonly card: VCard;
  readonly view: ContactView;
  readonly uid: string;
}

function tryParse(data: Buffer): Parsed | null {
  try {
    const card = parseVCard(data, { maxCards: 1 });
    const uid = getProperty(card, 'UID');
    return { card, view: contactOf(card), uid: uid === undefined ? '' : textOf(uid).trim() };
  } catch {
    return null;
  }
}

/** Parsed cards by address book + name, valid while the etag matches. Least recently used goes. */
class ParsedCache {
  private readonly map = new Map<string, { etag: string; parsed: Parsed | null }>();
  get(key: string, etag: string): Parsed | null | undefined {
    const hit = this.map.get(key);
    if (hit === undefined || hit.etag !== etag) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.parsed;
  }
  set(key: string, etag: string, parsed: Parsed | null): void {
    this.map.delete(key);
    this.map.set(key, { etag, parsed });
    while (this.map.size > CACHE_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

function putStatus(res: Response, outcome: PutOutcome): boolean {
  switch (outcome.status) {
    case 'created':
    case 'updated':
      return true;
    case 'precondition-failed':
      res.status(412).json({ error: 'precondition_failed', message: 'The contact changed since it was read; reload it.' });
      return false;
    case 'uid-conflict':
      res.status(409).json({ error: 'uid_conflict', message: 'Another card in this address book has that UID.' });
      return false;
    case 'collection-gone':
      res.status(404).json({ error: 'not_found' });
      return false;
    case 'collection-full':
      res.status(507).json({ error: 'address_book_full', message: 'This address book holds as many cards as it may.' });
      return false;
  }
}

const matches = (v: ContactView, q: string): boolean => {
  const needle = q.toLowerCase();
  const hay = [v.displayName, v.fn, v.given, v.family, v.org, ...v.emails.map((e) => e.address), ...v.tels.map((t) => t.value)];
  return hay.some((h) => h.toLowerCase().includes(needle));
};

export function contactsRoutes(deps: ApiDeps): Router {
  const router = Router();
  const cache = new ParsedCache();
  // Registers the contact index for this database (the phishing check reads it), when a KEK is set.
  davFor(deps);

  const callerOf = (req: Request): Caller => ({ accountId: currentSession(req).accountId, context: getAuditContext(req) });

  /** Every card of these address books, parsed (from the cache when the etag still matches). */
  const cardsOf = async (store: DavStore, books: readonly Collection[]): Promise<{ book: Collection; name: string; etag: string; parsed: Parsed }[]> => {
    const out: { book: Collection; name: string; etag: string; parsed: Parsed }[] = [];
    for (const book of books) {
      const metas = await store.listResources(book.id);
      const stale = metas.filter((m) => cache.get(`${book.id}/${m.name}`, m.etag) === undefined).map((m) => m.name);
      if (stale.length > 0) for (const r of await store.getResources(book.id, stale)) cache.set(`${book.id}/${r.name}`, r.etag, tryParse(r.data));
      for (const m of metas) {
        const parsed = cache.get(`${book.id}/${m.name}`, m.etag);
        if (parsed !== undefined && parsed !== null) out.push({ book, name: m.name, etag: m.etag, parsed });
      }
    }
    return out;
  };

  const bookOf = async (store: DavStore, req: Request, id: string, res: Response): Promise<Collection | null> => {
    const c = await ownCollection(store, currentSession(req).accountId, 'addressbook', id);
    if (c === null) res.status(404).json({ error: 'not_found' });
    return c;
  };

  const summary = (c: { book: Collection; name: string; etag: string; parsed: Parsed }): ContactSummaryJson => ({
    addressBookId: c.book.id,
    name: c.name,
    etag: c.etag,
    uid: c.parsed.uid,
    displayName: c.parsed.view.displayName,
    emails: c.parsed.view.emails.map((e) => e.address),
    org: c.parsed.view.org,
    hasPhoto: c.parsed.view.hasPhoto,
  });

  const detail = (book: Collection, name: string, etag: string, parsed: Parsed): ContactJson => {
    const v = parsed.view;
    return {
      addressBookId: book.id,
      name,
      etag,
      uid: parsed.uid,
      displayName: v.displayName,
      fn: v.fn,
      given: v.given,
      family: v.family,
      emails: v.emails.map((e) => ({ address: e.address, type: e.type })),
      tels: v.tels.map((t) => ({ value: t.value, type: t.type })),
      org: v.org,
      note: v.note,
      hasPhoto: v.hasPhoto,
    };
  };

  const write = async (
    store: DavStore,
    caller: Caller,
    book: Collection,
    input: { name: string; uid: string; card: VCard; ifMatch: string | null },
    maxBytes: number,
    res: Response,
  ): Promise<string | null> => {
    const data = Buffer.from(serializeVCard(input.card), 'utf8');
    if (data.length > maxBytes) {
      res.status(413).json({ error: 'too_large', message: 'The card is larger than a vCard may be.' });
      return null;
    }
    const outcome = await store.putResource(caller, book, {
      name: input.name,
      uid: input.uid,
      componentType: null,
      data,
      preconditions: input.ifMatch === null ? { ifNoneMatch: '*' } : { ifMatch: input.ifMatch },
    });
    if (!putStatus(res, outcome) || (outcome.status !== 'created' && outcome.status !== 'updated')) return null;
    return outcome.etag;
  };

  const hasName = (f: ContactFields): boolean => [f.fn, f.given, f.family, f.org].some((x) => x.trim() !== '') || f.emails.length > 0;

  router.get(
    '/address-books',
    handle(async (req, res) => {
      const dav = davFor(deps, res);
      if (dav === null) return;
      const books = await dav.store.listCollections(currentSession(req).accountId, 'addressbook');
      const out: AddressBookJson[] = [];
      for (const b of books) out.push({ id: b.id, displayName: b.displayName, slug: b.slug, count: (await dav.store.listResources(b.id)).length });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ addressBooks: out });
    }),
  );

  router.get(
    '/',
    handle(async (req, res) => {
      const query = parse(ContactListQuery, req.query, res);
      if (query === null) return;
      const dav = davFor(deps, res);
      if (dav === null) return;
      const books = (await dav.store.listCollections(currentSession(req).accountId, 'addressbook')).filter((b) => query.addressBookId === undefined || b.id === query.addressBookId);
      const q = query.q ?? '';
      const all = (await cardsOf(dav.store, books)).filter((c) => q === '' || matches(c.parsed.view, q));
      all.sort((a, b) => a.parsed.view.displayName.localeCompare(b.parsed.view.displayName, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name));
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ contacts: all.slice(0, MAX_LIST).map(summary), truncated: all.length > MAX_LIST });
    }),
  );

  router.get(
    '/lookup',
    handle(async (req, res) => {
      const query = parse(LookupQuery, req.query, res);
      if (query === null) return;
      const dav = davFor(deps, res);
      if (dav === null) return;
      const hit = await dav.contacts.lookup(currentSession(req).accountId, query.address);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ contact: hit === null ? null : { addressBookId: hit.addressBookId, name: hit.resourceName, displayName: hit.name } });
    }),
  );

  router.post(
    '/address-books/:addressBookId/cards',
    handle(async (req, res) => {
      const params = parse(AddressBookParams, req.params, res);
      if (params === null) return;
      const body = parse(ContactRequest, req.body, res);
      if (body === null) return;
      if (!hasName(body)) {
        res.status(400).json({ error: 'invalid_request', message: 'Give the contact a name, an organisation or an e-mail address.' });
        return;
      }
      const dav = davFor(deps, res);
      if (dav === null) return;
      const book = await bookOf(dav.store, req, params.addressBookId, res);
      if (book === null) return;
      const uid = randomUUID().toUpperCase();
      const name = `${uid}.vcf`;
      const etag = await write(dav.store, callerOf(req), book, { name, uid, card: buildContactCard(uid, body, new Date()), ifMatch: null }, dav.maxResourceBytes, res);
      if (etag === null) return;
      const json: ContactSavedJson = { addressBookId: book.id, name, uid, etag };
      res.setHeader('ETag', formatEtag(etag));
      res.status(201).json(json);
    }),
  );

  const loadCard = async (store: DavStore, book: Collection, name: string, res: Response): Promise<{ etag: string; parsed: Parsed } | null> => {
    const r = (await store.getResources(book.id, [name]))[0];
    if (r === undefined) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    const parsed = tryParse(r.data);
    if (parsed === null) {
      res.status(409).json({ error: 'unreadable', message: 'This card cannot be parsed.' });
      return null;
    }
    return { etag: r.etag, parsed };
  };

  router.get(
    '/address-books/:addressBookId/cards/:name',
    handle(async (req, res) => {
      const params = parse(CardParams, req.params, res);
      if (params === null) return;
      const dav = davFor(deps, res);
      if (dav === null) return;
      const book = await bookOf(dav.store, req, params.addressBookId, res);
      if (book === null) return;
      const found = await loadCard(dav.store, book, params.name, res);
      if (found === null) return;
      res.setHeader('ETag', formatEtag(found.etag));
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(detail(book, params.name, found.etag, found.parsed));
    }),
  );

  router.put(
    '/address-books/:addressBookId/cards/:name',
    handle(async (req, res) => {
      const params = parse(CardParams, req.params, res);
      if (params === null) return;
      const body = parse(ContactRequest, req.body, res);
      if (body === null) return;
      const ifMatch = ifMatchOf(req.get('if-match'));
      if (ifMatch === null) {
        res.status(428).json({ error: 'precondition_required', message: 'Send If-Match with the contact’s ETag.' });
        return;
      }
      if (!hasName(body)) {
        res.status(400).json({ error: 'invalid_request', message: 'Give the contact a name, an organisation or an e-mail address.' });
        return;
      }
      const dav = davFor(deps, res);
      if (dav === null) return;
      const book = await bookOf(dav.store, req, params.addressBookId, res);
      if (book === null) return;
      const found = await loadCard(dav.store, book, params.name, res);
      if (found === null) return;
      const card = applyContactFields(found.parsed.card, body, new Date());
      const etag = await write(dav.store, callerOf(req), book, { name: params.name, uid: found.parsed.uid, card, ifMatch }, dav.maxResourceBytes, res);
      if (etag === null) return;
      const json: ContactSavedJson = { addressBookId: book.id, name: params.name, uid: found.parsed.uid, etag };
      res.setHeader('ETag', formatEtag(etag));
      res.json(json);
    }),
  );

  router.delete(
    '/address-books/:addressBookId/cards/:name',
    handle(async (req, res) => {
      const params = parse(CardParams, req.params, res);
      if (params === null) return;
      const ifMatch = ifMatchOf(req.get('if-match'));
      if (ifMatch === null) {
        res.status(428).json({ error: 'precondition_required', message: 'Send If-Match with the contact’s ETag.' });
        return;
      }
      const dav = davFor(deps, res);
      if (dav === null) return;
      const book = await bookOf(dav.store, req, params.addressBookId, res);
      if (book === null) return;
      const outcome = await dav.store.deleteResource(callerOf(req), book, params.name, { ifMatch });
      if (outcome === 'not-found') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (outcome === 'precondition-failed') {
        res.status(412).json({ error: 'precondition_failed', message: 'The contact changed since it was read; reload it.' });
        return;
      }
      res.status(204).end();
    }),
  );

  return router;
}
