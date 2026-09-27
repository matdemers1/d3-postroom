// Serves the MTA-STS policy (RFC 8461, PST-T-4.12, PST-REQ-094) at
// `https://mta-sts.<domain>/.well-known/mta-sts.txt`. Public — no session, no CSRF, GET only —
// mounted at the site root ahead of the session gate and the SPA fallback, the same way
// apps/api/src/autoconfig is (see app.ts).
import { Router, type Request, type Response } from 'express';
import { normalizeDomain } from '@postroom/db';
import { handle } from '../auth/middleware.js';
import type { ApiDeps } from '../deps.js';
import { MtaStsConfigError, mtaStsEnvConfig, mtaStsPolicyId, renderMtaStsPolicy, type MtaStsPolicyConfig } from './policy.js';

export { MtaStsConfigError, mtaStsEnvConfig, mtaStsPolicyId, renderMtaStsPolicy, type MtaStsMode, type MtaStsPolicyConfig } from './policy.js';

const HOST_PREFIX = 'mta-sts.';

/** The domain a request at `mta-sts.<domain>` names, or undefined when the Host has no such label. */
export function domainFromMtaStsHost(hostname: string): string | undefined {
  if (!hostname.toLowerCase().startsWith(HOST_PREFIX)) return undefined;
  try {
    return normalizeDomain(hostname.slice(HOST_PREFIX.length));
  } catch {
    return undefined;
  }
}

export interface RenderedMtaStsPolicy {
  readonly text: string;
  readonly id: string;
}

/**
 * The policy Postroom would serve for `domain` right now, and the config it was built from.
 * `defaultMxHost` is the mx line's fallback when MX_HOSTNAME is unset — the primary domain's mx
 * host (PST-T-4.12): every domain Postroom hosts is delivered by the one physical MTA.
 */
export function currentMtaStsPolicy(env: NodeJS.ProcessEnv, defaultMxHost: string): { config: MtaStsPolicyConfig } & RenderedMtaStsPolicy {
  const config = mtaStsEnvConfig(env, defaultMxHost);
  const text = renderMtaStsPolicy(config);
  return { config, text, id: mtaStsPolicyId(text) };
}

export function mtaStsRoutes(deps: ApiDeps): Router {
  const router = Router();

  router.get(
    '/.well-known/mta-sts.txt',
    handle(async (req: Request, res: Response): Promise<void> => {
      const domain = domainFromMtaStsHost(req.hostname);
      if (domain === undefined) {
        res.status(404).end();
        return;
      }
      const found = await deps.db.domain.findFirst({ where: { name: domain } });
      if (found === null) {
        res.status(404).end();
        return;
      }
      // Every hosted domain is delivered by the one physical MTA: the mx line defaults to the
      // primary domain's host, not this domain's own name, unless MX_HOSTNAME overrides it.
      const primary = found.isPrimary ? found : ((await deps.db.domain.findFirst({ where: { isPrimary: true } })) ?? found);
      let policy: RenderedMtaStsPolicy;
      try {
        policy = currentMtaStsPolicy(deps.env, `mx.${primary.name}`);
      } catch (error) {
        if (error instanceof MtaStsConfigError) {
          process.stderr.write(`${JSON.stringify({ event: 'mta-sts-config-error', message: error.message })}\n`);
          res.status(503).end();
          return;
        }
        throw error;
      }
      res.set('Content-Type', 'text/plain');
      // Senders are expected to poll _mta-sts TXT first and re-fetch on an id change; a short
      // cache still saves a fetch per message while a crawler is warm.
      res.set('Cache-Control', 'public, max-age=300');
      res.send(policy.text);
    }),
  );

  return router;
}
