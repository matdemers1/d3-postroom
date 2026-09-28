// The MTA-STS policy body (RFC 8461 §3.2) and its DNS `id` (PST-T-4.12, PST-REQ-094). Pure: no db,
// no network, so "the id changes exactly when the policy changes" is a unit-testable property.
import { createHash } from 'node:crypto';
import { envInt, envString } from '@postroom/daemon';

export type MtaStsMode = 'testing' | 'enforce' | 'none';

const MODES: readonly MtaStsMode[] = ['testing', 'enforce', 'none'];

/** RFC 8461 §3.2: max_age is a TTL in seconds, capped at just over a year. */
export const MTA_STS_MAX_AGE_CEILING = 31_557_600;

export interface MtaStsPolicyConfig {
  readonly mode: MtaStsMode;
  readonly mxHost: string;
  readonly maxAge: number;
}

/** MTA_STS_MODE or MTA_STS_MAX_AGE named a value the policy cannot be built from. */
export class MtaStsConfigError extends Error {}

function isMode(value: string): value is MtaStsMode {
  return (MODES as readonly string[]).includes(value);
}

/**
 * MTA_STS_MODE (default `testing`) and MTA_STS_MAX_AGE (default 86400, one day) from the
 * environment, plus the mx host — MX_HOSTNAME if set, else `defaultMxHost`. Throws
 * MtaStsConfigError naming exactly what is wrong, rather than serving a policy nobody asked for.
 */
export function mtaStsEnvConfig(env: NodeJS.ProcessEnv, defaultMxHost: string): MtaStsPolicyConfig {
  const modeRaw = envString(env, 'MTA_STS_MODE', 'testing');
  if (!isMode(modeRaw)) {
    throw new MtaStsConfigError(`MTA_STS_MODE must be one of ${MODES.join(', ')}, got "${modeRaw}"`);
  }
  let maxAge: number;
  try {
    maxAge = envInt(env, 'MTA_STS_MAX_AGE', 86_400);
  } catch (error) {
    throw new MtaStsConfigError(error instanceof Error ? error.message : String(error));
  }
  if (maxAge <= 0 || maxAge > MTA_STS_MAX_AGE_CEILING) {
    throw new MtaStsConfigError(`MTA_STS_MAX_AGE must be between 1 and ${String(MTA_STS_MAX_AGE_CEILING)}, got ${String(maxAge)}`);
  }
  const mxHost = envString(env, 'MX_HOSTNAME', defaultMxHost);
  return { mode: modeRaw, mxHost, maxAge };
}

/** The exact bytes served at `/.well-known/mta-sts.txt` (RFC 8461 §3.2): version, mode, one mx
 * pattern, max_age — LF line endings, which the RFC allows and which matches every other text body
 * this app serves. */
export function renderMtaStsPolicy(config: MtaStsPolicyConfig): string {
  return `version: STSv1\nmode: ${config.mode}\nmx: ${config.mxHost}\nmax_age: ${String(config.maxAge)}\n`;
}

/**
 * The `id=` a sender should see in `_mta-sts.<domain>` TXT (RFC 8461 §3.1): 1–32 alphanumerics.
 * A content hash, not a timestamp or counter — it needs no clock and no storage, and it changes
 * exactly when (and only when) the policy body it is derived from changes.
 */
export function mtaStsPolicyId(policyText: string): string {
  return createHash('sha256').update(policyText, 'utf8').digest('hex').slice(0, 32);
}
