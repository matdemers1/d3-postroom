// Calendars, address books and their resources in PostgreSQL (PST-REQ-132, PST-REQ-133).
//
// Every mutation — collection create/update/delete, resource create/update/delete — writes its
// audit row in the same transaction as the change (PST-REQ-009). Audit rows name the collection,
// the resource, its etag and size, never the calendar or contact data itself.
//
// Sync (RFC 6578): a collection's `sync_seq` is its change counter. A write locks the collection row
// (SELECT … FOR UPDATE), takes seq + 1, stamps the resource's mod_seq with it and appends a
// dav_change row, all in one transaction, so a token (a seq) names exactly the set of changes before
// it. The sync token and CalendarServer's getctag are both derived from it.
import { randomBytes, randomUUID } from 'node:crypto';
import { recordAudit, type Actor, type RequestContext } from '@postroom/audit';
import type { Kek } from '@postroom/crypto';
import { Prisma, type Db } from '@postroom/db';
import { evaluatePreconditions, type Preconditions, type XmlElement } from '@postroom/dav-proto';
import { openResource, sealResource } from './seal.js';

export type Kind = 'calendar' | 'addressbook';

export interface Collection {
  readonly id: string;
  readonly accountId: string;
  readonly kind: Kind;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly color: string | null;
  readonly sortOrder: number | null;
  readonly components: string[];
  /** Clark name → the property element as the client set it. */
  readonly deadProps: Record<string, XmlElement>;
  readonly syncSeq: bigint;
  readonly updatedAt: Date;
}

export interface ResourceMeta {
  readonly id: string;
  readonly name: string;
  readonly uid: string;
  readonly componentType: string | null;
  readonly etag: string;
  readonly size: number;
  readonly modSeq: bigint;
  readonly updatedAt: Date;
}

export interface Resource extends ResourceMeta {
  readonly data: Buffer;
}

/** Who is acting, and from where, for audit rows. */
export interface Caller {
  readonly accountId: string;
  readonly context: RequestContext;
}

export interface CollectionFields {
  displayName: string;
  description: string | null;
  color: string | null;
  sortOrder: number | null;
  components: string[];
  deadProps: Record<string, XmlElement>;
}

export type PutOutcome =
  | { readonly status: 'created' | 'updated'; readonly etag: string }
  | { readonly status: 'precondition-failed' }
  | { readonly status: 'uid-conflict'; readonly existingName: string }
  | { readonly status: 'collection-gone' }
  | { readonly status: 'collection-full' };

export type DeleteOutcome = 'deleted' | 'not-found' | 'precondition-failed';

export interface Change {
  readonly name: string;
  readonly deleted: boolean;
  readonly seq: bigint;
}

const META_SELECT = { id: true, name: true, uid: true, componentType: true, etag: true, size: true, modSeq: true, updatedAt: true } as const;
const TX = { maxWait: 10_000, timeout: 30_000 } as const;

function actor(c: Caller): Actor {
  return { kind: 'account', accountId: c.accountId };
}

function toCollection(row: {
  id: string;
  accountId: string;
  kind: Kind;
  slug: string;
  displayName: string;
  description: string | null;
  color: string | null;
  sortOrder: number | null;
  components: string[];
  deadProps: Prisma.JsonValue;
  syncSeq: bigint;
  updatedAt: Date;
}): Collection {
  const dead = row.deadProps !== null && typeof row.deadProps === 'object' && !Array.isArray(row.deadProps) ? (row.deadProps as unknown as Record<string, XmlElement>) : {};
  return { ...row, deadProps: dead };
}

/** A fresh strong entity tag. Random, not a hash: a hash of the plaintext would leak equality. */
export function newEtag(): string {
  return randomBytes(12).toString('base64url');
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export class DavStore {
  constructor(
    private readonly db: Db,
    private readonly kek: Kek,
    private readonly limits: { readonly maxCollectionsPerAccount: number; readonly maxResourcesPerCollection: number },
  ) {}

  async listCollections(accountId: string, kind: Kind): Promise<Collection[]> {
    const rows = await this.db.davCollection.findMany({ where: { accountId, kind }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(toCollection);
  }

  async getCollection(accountId: string, kind: Kind, slug: string): Promise<Collection | null> {
    const row = await this.db.davCollection.findUnique({ where: { accountId_kind_slug: { accountId, kind, slug } } });
    return row === null ? null : toCollection(row);
  }

  /** Null when a collection by that name already exists; 'full' at the per-account cap. */
  async createCollection(caller: Caller, kind: Kind, slug: string, fields: CollectionFields): Promise<Collection | null | 'full'> {
    try {
      return await this.db.$transaction(async (tx) => {
        const count = await tx.davCollection.count({ where: { accountId: caller.accountId } });
        if (count >= this.limits.maxCollectionsPerAccount) return 'full' as const;
        const row = await tx.davCollection.create({
          data: {
            accountId: caller.accountId,
            kind,
            slug,
            displayName: fields.displayName,
            description: fields.description,
            color: fields.color,
            sortOrder: fields.sortOrder,
            components: fields.components,
            deadProps: fields.deadProps as unknown as Prisma.InputJsonObject,
          },
        });
        await recordAudit(tx, {
          actor: actor(caller),
          action: 'dav.collection.create',
          entityType: 'dav_collection',
          entityId: row.id,
          after: { kind, slug, displayName: fields.displayName, components: fields.components, deadProps: Object.keys(fields.deadProps) },
          context: caller.context,
        });
        return toCollection(row);
      }, TX);
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async updateCollection(caller: Caller, before: Collection, fields: CollectionFields): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.davCollection.update({
        where: { id: before.id },
        data: {
          displayName: fields.displayName,
          description: fields.description,
          color: fields.color,
          sortOrder: fields.sortOrder,
          deadProps: fields.deadProps as unknown as Prisma.InputJsonObject,
        },
      });
      await recordAudit(tx, {
        actor: actor(caller),
        action: 'dav.collection.update',
        entityType: 'dav_collection',
        entityId: before.id,
        before: { displayName: before.displayName, description: before.description, color: before.color, sortOrder: before.sortOrder, deadProps: Object.keys(before.deadProps) },
        after: { displayName: fields.displayName, description: fields.description, color: fields.color, sortOrder: fields.sortOrder, deadProps: Object.keys(fields.deadProps) },
        context: caller.context,
      });
    }, TX);
  }

  async deleteCollection(caller: Caller, collection: Collection): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const resources = await tx.davResource.count({ where: { collectionId: collection.id } });
      // Cascades to the resources (and with them their wrapped DEKs) and the change log.
      await tx.davCollection.delete({ where: { id: collection.id } });
      await recordAudit(tx, {
        actor: actor(caller),
        action: 'dav.collection.delete',
        entityType: 'dav_collection',
        entityId: collection.id,
        before: { kind: collection.kind, slug: collection.slug, displayName: collection.displayName, resources },
        context: caller.context,
      });
    }, TX);
  }

  /** The collection's current sync sequence (fresh from the database, not a cached row). */
  async currentSeq(collectionId: string): Promise<bigint | null> {
    const row = await this.db.davCollection.findUnique({ where: { id: collectionId }, select: { syncSeq: true } });
    return row?.syncSeq ?? null;
  }

  async listResources(collectionId: string): Promise<ResourceMeta[]> {
    return this.db.davResource.findMany({ where: { collectionId }, select: META_SELECT, orderBy: { modSeq: 'asc' } });
  }

  async getMeta(collectionId: string, name: string): Promise<ResourceMeta | null> {
    return this.db.davResource.findUnique({ where: { collectionId_name: { collectionId, name } }, select: META_SELECT });
  }

  /** Resources with their decrypted bytes: the named ones, or all of them. */
  async getResources(collectionId: string, names?: readonly string[]): Promise<Resource[]> {
    const rows = await this.db.davResource.findMany({
      where: names === undefined ? { collectionId } : { collectionId, name: { in: [...names] } },
      select: { ...META_SELECT, wrappedDek: true, data: true },
      orderBy: { modSeq: 'asc' },
    });
    return rows.map(({ wrappedDek, data, ...meta }) => ({ ...meta, data: openResource(this.kek, { id: meta.id, wrappedDek, data }) }));
  }

  /** Lock the collection row for this transaction and return its sync sequence; null if it is gone. */
  private async lock(tx: Prisma.TransactionClient, collectionId: string): Promise<bigint | null> {
    const rows = await tx.$queryRaw<{ sync_seq: bigint }[]>`SELECT "sync_seq" FROM "dav_collection" WHERE "id" = ${collectionId}::uuid FOR UPDATE`;
    return rows[0]?.sync_seq ?? null;
  }

  async putResource(
    caller: Caller,
    collection: Collection,
    input: { readonly name: string; readonly uid: string; readonly componentType: string | null; readonly data: Buffer; readonly preconditions: Preconditions },
  ): Promise<PutOutcome> {
    return this.db.$transaction(async (tx): Promise<PutOutcome> => {
      const seq = await this.lock(tx, collection.id);
      if (seq === null) return { status: 'collection-gone' };
      const existing = await tx.davResource.findUnique({ where: { collectionId_name: { collectionId: collection.id, name: input.name } }, select: META_SELECT });
      if (evaluatePreconditions(input.preconditions, existing?.etag ?? null, 'PUT') !== null) return { status: 'precondition-failed' };
      // CALDAV:/CARDDAV:no-uid-conflict: a UID lives at one href per collection, and an update may not change it.
      if (existing !== null && existing.uid !== input.uid) return { status: 'uid-conflict', existingName: existing.name };
      const holder = await tx.davResource.findUnique({ where: { collectionId_uid: { collectionId: collection.id, uid: input.uid } }, select: { name: true } });
      if (holder !== null && holder.name !== input.name) return { status: 'uid-conflict', existingName: holder.name };
      if (existing === null && (await tx.davResource.count({ where: { collectionId: collection.id } })) >= this.limits.maxResourcesPerCollection) {
        return { status: 'collection-full' };
      }

      const next = seq + 1n;
      const etag = newEtag();
      const id = existing?.id ?? randomUUID();
      const sealed = sealResource(this.kek, id, input.data);
      const common = {
        uid: input.uid,
        componentType: input.componentType,
        etag,
        size: input.data.length,
        wrappedDek: new Uint8Array(sealed.wrappedDek),
        kekId: sealed.kekId,
        data: new Uint8Array(sealed.data),
        modSeq: next,
      };
      if (existing === null) await tx.davResource.create({ data: { id, collectionId: collection.id, name: input.name, ...common } });
      else await tx.davResource.update({ where: { id }, data: common });
      await tx.davCollection.update({ where: { id: collection.id }, data: { syncSeq: next } });
      await tx.davChange.create({ data: { collectionId: collection.id, seq: next, name: input.name, deleted: false } });
      await recordAudit(tx, {
        actor: actor(caller),
        action: existing === null ? 'dav.resource.create' : 'dav.resource.update',
        entityType: 'dav_resource',
        entityId: id,
        ...(existing === null ? {} : { before: { etag: existing.etag, size: existing.size } }),
        after: { collectionId: collection.id, kind: collection.kind, name: input.name, componentType: input.componentType, etag, size: input.data.length },
        context: caller.context,
      });
      return { status: existing === null ? 'created' : 'updated', etag };
    }, TX);
  }

  async deleteResource(caller: Caller, collection: Collection, name: string, preconditions: Preconditions): Promise<DeleteOutcome> {
    return this.db.$transaction(async (tx): Promise<DeleteOutcome> => {
      const seq = await this.lock(tx, collection.id);
      if (seq === null) return 'not-found';
      const existing = await tx.davResource.findUnique({ where: { collectionId_name: { collectionId: collection.id, name } }, select: META_SELECT });
      if (existing === null) return 'not-found';
      if (evaluatePreconditions(preconditions, existing.etag, 'DELETE') !== null) return 'precondition-failed';
      const next = seq + 1n;
      await tx.davResource.delete({ where: { id: existing.id } });
      await tx.davCollection.update({ where: { id: collection.id }, data: { syncSeq: next } });
      await tx.davChange.create({ data: { collectionId: collection.id, seq: next, name, deleted: true } });
      await recordAudit(tx, {
        actor: actor(caller),
        action: 'dav.resource.delete',
        entityType: 'dav_resource',
        entityId: existing.id,
        before: { collectionId: collection.id, kind: collection.kind, name, componentType: existing.componentType, etag: existing.etag, size: existing.size },
        context: caller.context,
      });
      return 'deleted';
    }, TX);
  }

  /** Every change in (from, to], oldest first. */
  async changesBetween(collectionId: string, from: bigint, to: bigint): Promise<Change[]> {
    return this.db.davChange.findMany({
      where: { collectionId, seq: { gt: from, lte: to } },
      select: { name: true, deleted: true, seq: true },
      orderBy: { seq: 'asc' },
    });
  }

  /** The display name and live addresses of an account, for principal properties. */
  async principal(accountId: string): Promise<{ displayName: string; addresses: string[] }> {
    const account = await this.db.account.findUnique({
      where: { id: accountId },
      select: {
        displayName: true,
        addresses: { where: { killedAt: null }, select: { localPart: true, domain: { select: { name: true } } }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    return { displayName: account?.displayName ?? '', addresses: (account?.addresses ?? []).map((a) => `${a.localPart}@${a.domain.name}`) };
  }
}
