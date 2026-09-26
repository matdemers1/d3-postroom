// The webmail's door to calendars and address books: the SAME DavStore the DAV daemon writes
// through (@postroom/dav-store), so a web edit encrypts, etags, advances the sync token and audits
// exactly as an iPhone's PUT does — and the phone's next sync-collection reports it (PST-REQ-137).
import { contactIndexFor, DavStore, davLimitsFromEnv, type Collection, type ContactIndex, type Kind } from '@postroom/dav-store';
import type { Db } from '@postroom/db';
import type { Response } from 'express';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';

export interface DavAccess {
  readonly store: DavStore;
  readonly contacts: ContactIndex;
  /** DAV_MAX_RESOURCE_BYTES: the largest calendar object or vCard the DAV daemon accepts. */
  readonly maxResourceBytes: number;
}

const byDeps = new WeakMap<ApiDeps, DavAccess | null>();
const byDb = new WeakMap<Db, ContactIndex>();

/** The store for this app, or null (and a 503 answered) when POSTROOM_KEK is not set. */
export function davFor(deps: ApiDeps, res?: Response): DavAccess | null {
  let access = byDeps.get(deps);
  if (access === undefined) {
    const rt = runtimeFor(deps);
    if (rt.kek === null) {
      access = null;
    } else {
      const raw = Number(deps.env['DAV_MAX_RESOURCE_BYTES'] ?? '');
      access = {
        store: new DavStore(rt.db, rt.kek, davLimitsFromEnv(deps.env)),
        contacts: contactIndexFor(rt.db, rt.kek),
        maxResourceBytes: Number.isSafeInteger(raw) && raw > 0 ? raw : 4 * 1024 * 1024,
      };
      byDb.set(rt.db, access.contacts);
    }
    byDeps.set(deps, access);
  }
  if (access === null) res?.status(503).json({ error: 'blobstore_not_configured', message: 'POSTROOM_KEK is not set' });
  return access;
}

/**
 * The contact index of an app built on this database, for code that has only the database client
 * (the phishing check's contacts, PST-REQ-120). Null before any app registered one, or without a KEK.
 */
export function contactIndexOf(db: Db): ContactIndex | null {
  return byDb.get(db) ?? null;
}

/** One of the caller's collections by id, or null (another account's id is simply not found). */
export async function ownCollection(store: DavStore, accountId: string, kind: Kind, id: string): Promise<Collection | null> {
  return (await store.listCollections(accountId, kind)).find((c) => c.id === id) ?? null;
}

/** `"etag"` → `etag`, for the store's precondition check. The header is passed through as sent. */
export function ifMatchOf(header: string | undefined): string | null {
  const v = header?.trim() ?? '';
  return v === '' ? null : v;
}

export function formatEtag(etag: string): string {
  return `"${etag}"`;
}
