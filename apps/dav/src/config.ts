// dav configuration from the environment. Pure, so the defaults are unit-tested.
import { BlockList, isIP } from 'node:net';
import { envInt, envString } from '@postroom/daemon';

export interface DavConfig {
  readonly host: string;
  /** Plain HTTP: TLS terminates at Cloudflare, and the tunnel reaches us as http://dav:8008. */
  readonly port: number;
  /**
   * Peers whose X-Forwarded-Proto and CF-Connecting-IP / X-Forwarded-For are believed: the
   * cloudflared container. Addresses or CIDRs. Default: loopback and the private ranges a Docker
   * network lives in (nothing publishes this port, so only containers on the stack reach it).
   */
  readonly trustedProxies: readonly string[];
  /**
   * Refuse credentials that did not arrive over HTTPS (as vouched for by a trusted proxy). Basic
   * auth over plain HTTP would hand the app password to anyone on the path. Default true.
   */
  readonly requireHttps: boolean;
  /** XML request bodies (PROPFIND, REPORT, …). */
  readonly maxXmlBytes: number;
  /** One calendar object or vCard (CALDAV:/CARDDAV:max-resource-size). */
  readonly maxResourceBytes: number;
  readonly maxCollectionsPerAccount: number;
  readonly maxResourcesPerCollection: number;
  /** How long a verified app password is remembered, so every request is not an Argon2id verify. */
  readonly authCacheMs: number;
}

export const DEFAULT_TRUSTED_PROXIES = ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];

export function loadConfig(env: NodeJS.ProcessEnv): DavConfig {
  const proxies = envString(env, 'DAV_TRUSTED_PROXIES', DEFAULT_TRUSTED_PROXIES.join(','))
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  trustedProxyList(proxies); // validate now: a typo must stop the daemon, not trust nobody silently
  return {
    host: envString(env, 'LISTEN_HOST', '0.0.0.0'),
    port: envInt(env, 'LISTEN_PORT', 8008),
    trustedProxies: proxies,
    requireHttps: envString(env, 'DAV_REQUIRE_HTTPS', 'true').toLowerCase() !== 'false',
    maxXmlBytes: envInt(env, 'DAV_MAX_XML_BYTES', 1024 * 1024),
    maxResourceBytes: envInt(env, 'DAV_MAX_RESOURCE_BYTES', 4 * 1024 * 1024),
    maxCollectionsPerAccount: envInt(env, 'DAV_MAX_COLLECTIONS', 64),
    maxResourcesPerCollection: envInt(env, 'DAV_MAX_RESOURCES', 50_000),
    authCacheMs: envInt(env, 'DAV_AUTH_CACHE_MS', 5 * 60_000),
  };
}

/** A matcher for the trusted-proxy list. Throws on an entry that is neither an address nor a CIDR. */
export function trustedProxyList(entries: readonly string[]): (ip: string) => boolean {
  const list = new BlockList();
  for (const entry of entries) {
    const [addr = '', bits] = entry.split('/');
    const family = isIP(addr);
    if (family === 0) throw new Error(`DAV_TRUSTED_PROXIES: "${entry}" is not an address or CIDR`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) {
      list.addAddress(addr, type);
    } else {
      const prefix = Number(bits);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) throw new Error(`DAV_TRUSTED_PROXIES: bad prefix in "${entry}"`);
      list.addSubnet(addr, prefix, type);
    }
  }
  return (ip: string) => {
    const bare = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
    const family = isIP(bare);
    if (family === 0) return false;
    return list.check(bare, family === 4 ? 'ipv4' : 'ipv6');
  };
}
