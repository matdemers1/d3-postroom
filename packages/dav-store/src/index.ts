// The one write path for calendars and address books (PST-T-8.2, PST-T-8.5): the DAV daemon, the
// webmail API and submission's contact harvest all write through DavStore, so a web edit and an
// iPhone edit are the same kind of change — encrypted, etagged, sync-token advancing and audited.
export const PACKAGE = '@postroom/dav-store';

export { DavStore, newEtag } from './store.js';
export type { Caller, Change, Collection, CollectionFields, DeleteOutcome, Kind, PutOutcome, Resource, ResourceMeta } from './store.js';
export { openResource, sealResource } from './seal.js';
export type { Sealed } from './seal.js';
export { applyContactFields, buildContactCard, contactCardBytes, contactOf, contactOfBytes, revStamp } from './card.js';
export type { ContactEmail, ContactFields, ContactTel, ContactView } from './card.js';
export {
  COLLECTED_NAME,
  COLLECTED_SLUG,
  collectedUid,
  ContactIndex,
  contactIndexFor,
  harvestRecipients,
  isNoReplyAddress,
  isRoleAddress,
  isRoleLocalPart,
  MAX_HARVEST_PER_MESSAGE,
  parseListPost,
} from './contacts.js';
export type { ContactEntry, ContactIndexOptions, HarvestInput, HarvestResult } from './contacts.js';
export { DEFAULT_DAV_LIMITS, davLimitsFromEnv } from './limits.js';
export type { DavLimits } from './limits.js';
