// Where failures are remembered. The production ledger IS the audit log: each failure is one
// audit_event row (PST-REQ-009, PST-REQ-075), and the streak is counted back out of those rows. That
// survives a restart and is shared by the separate daemon containers (IMAP, submission, DAV,
// ManageSieve) without a table of its own. The memory ledger is for unit tests.
import { randomUUID } from 'node:crypto';
import { recordAudit } from '@postroom/audit';
import type { Db } from '@postroom/db';

export const FAILURE_ACTION = 'auth.failure';
export const FAILURE_ENTITY = 'credential';

export interface FailureEntry {
  readonly protocol: string;
  /** Lowercased. Also the audit row's entity_id, so the (entity_type, entity_id) index finds it. */
  readonly username: string;
  readonly ip: string;
  readonly network: string;
  readonly source: string;
  readonly reason: string;
}

export interface FailureQuery {
  readonly username: string;
  readonly network: string;
  readonly source: string;
  /** Start of the sliding window. */
  readonly since: Date;
  /** Start of this (username, network)'s streak: `since`, or the last success if later. */
  readonly streakSince: Date;
}

export interface FailureCounts {
  /** Failures for (username, network) since `streakSince`. */
  readonly streak: number;
  /** Failures from `source`, any username, since `since`. */
  readonly source: number;
}

export interface FailureLedger {
  record(entry: FailureEntry): Promise<void>;
  count(query: FailureQuery): Promise<FailureCounts>;
}

/**
 * The audit log as the ledger. Never holds a password: the row carries protocol, username, network,
 * source and a reason code, and `recordAudit` redacts anything secret-shaped besides.
 */
export function auditLedger(db: Db): FailureLedger {
  return {
    async record(e) {
      await recordAudit(db, {
        actor: { kind: 'anonymous' },
        action: FAILURE_ACTION,
        entityType: FAILURE_ENTITY,
        entityId: e.username,
        after: { protocol: e.protocol, username: e.username, network: e.network, source: e.source, reason: e.reason },
        context: { requestId: randomUUID(), ip: e.ip },
      });
    },
    async count(q) {
      // One pass over the window, driven by the index on `at`. For heavy traffic, a partial index
      // `ON audit_event (at) WHERE action = 'auth.failure'` keeps the scan to failures only.
      const rows = await db.$queryRaw<{ streak: number; source: number }[]>`
        SELECT
          count(*) FILTER (
            WHERE entity_id = ${q.username} AND after->>'network' = ${q.network} AND at >= ${q.streakSince}
          )::int AS streak,
          count(*) FILTER (WHERE after->>'source' = ${q.source})::int AS source
        FROM audit_event
        WHERE action = ${FAILURE_ACTION} AND entity_type = ${FAILURE_ENTITY} AND at > ${q.since}`;
      const row = rows[0];
      return { streak: row?.streak ?? 0, source: row?.source ?? 0 };
    },
  };
}

/** In-process ledger with the same semantics, for unit tests and tools. Timestamps from `now`. */
export function memoryLedger(now: () => number = Date.now): FailureLedger & { readonly entries: readonly (FailureEntry & { at: number })[] } {
  const entries: (FailureEntry & { at: number })[] = [];
  return {
    entries,
    record(e) {
      entries.push({ ...e, at: now() });
      return Promise.resolve();
    },
    count(q) {
      const since = q.since.getTime();
      const streakSince = q.streakSince.getTime();
      let streak = 0;
      let source = 0;
      for (const e of entries) {
        if (e.at <= since) continue;
        if (e.source === q.source) source += 1;
        if (e.username === q.username && e.network === q.network && e.at >= streakSince) streak += 1;
      }
      return Promise.resolve({ streak, source });
    },
  };
}
