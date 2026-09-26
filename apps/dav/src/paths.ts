// The URL space:
//
//   /.well-known/caldav, /.well-known/carddav   → 301 to /dav/ (RFC 6764 §5)
//   /  and  /dav/                               the context root: answers current-user-principal
//   /dav/principals/<account>/                  the principal
//   /dav/calendars/<account>/                   calendar-home-set
//   /dav/calendars/<account>/<calendar>/        a calendar collection
//   /dav/calendars/<account>/<calendar>/<name>  a calendar object resource (an .ics)
//   /dav/addressbooks/<account>/…               the same for address books and vCards
//
// <account> is the account id — stable across address changes. Another account's id is a 404: a
// client can only ever see its own tree.
import { hrefOf } from '@postroom/dav-proto';
import type { Kind } from './store.js';

export const CONTEXT_PATH = '/dav/';

export type Target =
  | { readonly type: 'root' }
  | { readonly type: 'principal' }
  | { readonly type: 'home'; readonly kind: Kind }
  | { readonly type: 'collection'; readonly kind: Kind; readonly slug: string }
  | { readonly type: 'object'; readonly kind: Kind; readonly slug: string; readonly name: string };

export type Route = { readonly type: 'well-known' } | { readonly type: 'not-found' } | { readonly type: 'dav'; readonly accountId: string | null; readonly target: Target };

const HOMES: Readonly<Record<string, Kind>> = { calendars: 'calendar', addressbooks: 'addressbook' };
const HOME_SEGMENT: Readonly<Record<Kind, string>> = { calendar: 'calendars', addressbook: 'addressbooks' };

/** Where decoded path segments point. `accountId` is the one named in the path (null at the root). */
export function route(segments: readonly string[]): Route {
  const [a, b, c, d, e, ...rest] = segments;
  if (a === '.well-known' && (b === 'caldav' || b === 'carddav') && c === undefined) return { type: 'well-known' };
  if (a === undefined) return { type: 'dav', accountId: null, target: { type: 'root' } };
  if (a !== 'dav' || rest.length > 0) return { type: 'not-found' };
  if (b === undefined) return { type: 'dav', accountId: null, target: { type: 'root' } };
  if (c === undefined) return { type: 'not-found' };
  if (b === 'principals') return d === undefined ? { type: 'dav', accountId: c, target: { type: 'principal' } } : { type: 'not-found' };
  const kind = HOMES[b];
  if (kind === undefined) return { type: 'not-found' };
  if (d === undefined) return { type: 'dav', accountId: c, target: { type: 'home', kind } };
  if (e === undefined) return { type: 'dav', accountId: c, target: { type: 'collection', kind, slug: d } };
  return { type: 'dav', accountId: c, target: { type: 'object', kind, slug: d, name: e } };
}

export function principalHref(accountId: string): string {
  return hrefOf(['dav', 'principals', accountId], true);
}

export function homeHref(accountId: string, kind: Kind): string {
  return hrefOf(['dav', HOME_SEGMENT[kind], accountId], true);
}

export function collectionHref(accountId: string, kind: Kind, slug: string): string {
  return hrefOf(['dav', HOME_SEGMENT[kind], accountId, slug], true);
}

export function objectHref(accountId: string, kind: Kind, slug: string, name: string): string {
  return hrefOf(['dav', HOME_SEGMENT[kind], accountId, slug, name], false);
}

export function targetHref(accountId: string, t: Target): string {
  switch (t.type) {
    case 'root':
      return CONTEXT_PATH;
    case 'principal':
      return principalHref(accountId);
    case 'home':
      return homeHref(accountId, t.kind);
    case 'collection':
      return collectionHref(accountId, t.kind, t.slug);
    case 'object':
      return objectHref(accountId, t.kind, t.slug, t.name);
  }
}
