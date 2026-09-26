// Prisma schema, client and seed — the one database shape every daemon shares.
export const PACKAGE = '@postroom/db';

export { createDb, Prisma, type Db } from './db.js';
export { AddressKind, SpecialUse, AppPasswordScope, ActorKind, AccountKind, DkimAlgorithm, JobStatus, RecipientState } from './generated/prisma/enums.js';
export type {
  Account,
  IdentityLink,
  AppPassword,
  Session,
  Setting,
  Domain,
  Address,
  AddressTarget,
  Mailbox,
  Message,
  Blob,
  AuditEvent,
  DkimKey,
  Job,
  OutboundMessage,
  OutboundRecipient,
  DeliveryAttempt,
} from './generated/prisma/client.js';
export { normalizeDomain, normalizeLocalPart, parseAddress, randomUidValidity, type ParsedAddress } from './normalize.js';
export { seed, DEFAULT_MAILBOXES, type SeedOptions, type SeedResult } from './seeding.js';
export { schemaRevision } from './revision.js';
