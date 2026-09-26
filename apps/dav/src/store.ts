// The DAV store lives in @postroom/dav-store (PST-T-8.5), so the webmail's calendar and contacts
// screens write through exactly the same path — encrypted bytes, etag, sync token, change log and
// audit row in one transaction — and an iPhone's sync-collection sees a web edit like any other.
export * from '@postroom/dav-store';
