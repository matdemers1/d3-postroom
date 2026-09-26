// The per-account caps DavStore enforces. The DAV daemon reads them from its own config; every
// other writer (the webmail API, submission's harvest) reads the same variables, with the same
// defaults, so a collection full over DAV is full from the web too.
export interface DavLimits {
  readonly maxCollectionsPerAccount: number;
  readonly maxResourcesPerCollection: number;
}

export const DEFAULT_DAV_LIMITS: DavLimits = { maxCollectionsPerAccount: 64, maxResourcesPerCollection: 50_000 };

function positive(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function davLimitsFromEnv(env: Readonly<Record<string, string | undefined>>): DavLimits {
  return {
    maxCollectionsPerAccount: positive(env['DAV_MAX_COLLECTIONS'], DEFAULT_DAV_LIMITS.maxCollectionsPerAccount),
    maxResourcesPerCollection: positive(env['DAV_MAX_RESOURCES'], DEFAULT_DAV_LIMITS.maxResourcesPerCollection),
  };
}
