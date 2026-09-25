// A tiny, hand-rolled OpenID Connect issuer for tests: the D3 Auth shapes Postroom's relying party
// depends on, and nothing else. RS256 keys from node:crypto, an /authorize that approves at once for
// the configured user, a /token that insists on client_secret_basic and PKCE S256, and a signer for
// back-channel logout tokens.
//
// In-process:  const issuer = await startFakeIssuer({ port: 0, user: { sub: 'u1', roles: ['admin'] } });
// Standalone:  node e2e/fake-issuer/server.mjs --port 9400 [--client-id postroom] [--client-secret s]
//              [--sub u-1] [--email a@example.com] [--name Name] [--roles admin,viewer]
// NEVER a real issuer: it approves everyone who asks.
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const b64url = (input) => Buffer.from(input).toString('base64url');

function signJwt(privateKey, kid, header, payload) {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid, ...header }));
  const body = b64url(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * @param {object} [options]
 * @param {number} [options.port] 0 for any free port
 * @param {string} [options.host]
 * @param {string} [options.clientId]
 * @param {string} [options.clientSecret]
 * @param {{ sub: string, email?: string, name?: string, roles?: string[] }} [options.user]
 */
export async function startFakeIssuer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const clientId = options.clientId ?? 'postroom';
  const clientSecret = options.clientSecret ?? 'fake-issuer-secret';
  let user = { roles: [], ...(options.user ?? { sub: 'fake-user-1', email: 'fake.user@example.com', name: 'Fake User' }) };

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(8).toString('hex');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  /** code -> the authorization it stands for */
  const codes = new Map();
  const tokens = new Map();
  const stats = { authorize: 0, token: 0 };
  let issuer = '';

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      json(res, 500, { error: 'server_error', error_description: String(error) });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', issuer);
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/oidc/jwks`,
        end_session_endpoint: `${issuer}/session/end`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        scopes_supported: ['openid', 'profile', 'email', 'd3:roles'],
        claims_supported: ['sub', 'email', 'name', 'roles'],
        backchannel_logout_supported: true,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/oidc/jwks') {
      json(res, 200, { keys: [jwk] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/readyz') {
      json(res, 200, { status: 'ok' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      stats.authorize += 1;
      const p = url.searchParams;
      const redirectUri = p.get('redirect_uri') ?? '';
      if (p.get('client_id') !== clientId || redirectUri === '') {
        json(res, 400, { error: 'invalid_request', error_description: 'unknown client or redirect_uri' });
        return;
      }
      if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) {
        json(res, 400, { error: 'invalid_request', error_description: 'code flow with PKCE S256 only' });
        return;
      }
      const code = randomBytes(24).toString('base64url');
      codes.set(code, {
        redirectUri,
        nonce: p.get('nonce') ?? undefined,
        challenge: p.get('code_challenge'),
        scope: p.get('scope') ?? '',
        user: { ...user },
        exp: Date.now() + 60_000,
      });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      const state = p.get('state');
      if (state !== null) back.searchParams.set('state', state);
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      stats.token += 1;
      const auth = req.headers.authorization ?? '';
      const [scheme, value] = auth.split(' ');
      const decoded = scheme === 'Basic' && value ? Buffer.from(value, 'base64').toString('utf8') : '';
      const sep = decoded.indexOf(':');
      const id = decodeURIComponent(decoded.slice(0, sep));
      const secret = decodeURIComponent(decoded.slice(sep + 1));
      if (sep < 0 || id !== clientId || secret !== clientSecret) {
        json(res, 401, { error: 'invalid_client' }, { 'www-authenticate': 'Basic' });
        return;
      }
      const form = new URLSearchParams(await readBody(req));
      if (form.has('client_secret')) {
        json(res, 400, { error: 'invalid_request', error_description: 'client_secret_post is not accepted' });
        return;
      }
      const grant = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (form.get('grant_type') !== 'authorization_code' || grant === undefined || grant.exp < Date.now()) {
        json(res, 400, { error: 'invalid_grant' });
        return;
      }
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== grant.challenge || form.get('redirect_uri') !== grant.redirectUri) {
        json(res, 400, { error: 'invalid_grant', error_description: 'PKCE or redirect_uri mismatch' });
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        sub: grant.user.sub,
        ...(grant.user.email ? { email: grant.user.email, email_verified: true } : {}),
        ...(grant.user.name ? { name: grant.user.name } : {}),
        roles: grant.user.roles ?? [],
      };
      const idToken = signJwt(privateKey, kid, { typ: 'JWT' }, {
        iss: issuer,
        aud: clientId,
        iat: now,
        exp: now + 300,
        auth_time: now,
        sid: randomUUID(),
        ...(grant.nonce ? { nonce: grant.nonce } : {}),
        ...claims,
      });
      const accessToken = randomBytes(24).toString('base64url');
      tokens.set(accessToken, claims);
      json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken, scope: grant.scope });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/userinfo') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const claims = tokens.get(token);
      if (claims === undefined) {
        json(res, 401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer error="invalid_token"' });
        return;
      }
      json(res, 200, claims);
      return;
    }
    json(res, 404, { error: 'not_found' });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  issuer = `http://${host}:${port}`;

  return {
    url: issuer,
    clientId,
    clientSecret,
    stats,
    /** Who /authorize approves from now on. */
    setUser(next) {
      user = { roles: [], ...next };
    },
    /** A back-channel logout token for `sub` (RFC: typ logout+jwt, events claim, jti, no nonce). */
    logoutToken(sub, extra = {}) {
      const now = Math.floor(Date.now() / 1000);
      return signJwt(privateKey, kid, { typ: 'logout+jwt' }, {
        iss: issuer,
        aud: clientId,
        iat: now,
        exp: now + 120,
        jti: randomUUID(),
        sub,
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
        ...extra,
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      });
    },
  };
}

function argValue(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const env = process.env;
  const roles = argValue(args, 'roles', env.FAKE_ISSUER_ROLES ?? 'admin');
  const issuer = await startFakeIssuer({
    port: Number(argValue(args, 'port', env.FAKE_ISSUER_PORT ?? '9400')),
    host: argValue(args, 'host', env.FAKE_ISSUER_HOST ?? '127.0.0.1'),
    clientId: argValue(args, 'client-id', env.FAKE_ISSUER_CLIENT_ID ?? 'postroom'),
    clientSecret: argValue(args, 'client-secret', env.FAKE_ISSUER_CLIENT_SECRET ?? 'fake-issuer-secret'),
    user: {
      sub: argValue(args, 'sub', env.FAKE_ISSUER_SUB ?? 'fake-admin-1'),
      email: argValue(args, 'email', env.FAKE_ISSUER_EMAIL ?? 'fake.admin@example.com'),
      name: argValue(args, 'name', env.FAKE_ISSUER_NAME ?? 'Fake D3 Auth Admin'),
      roles: roles === '' ? [] : roles.split(','),
    },
  });
  process.stdout.write(`${JSON.stringify({ event: 'fake-issuer-listening', issuer: issuer.url, clientId: issuer.clientId })}\n`);
  const stop = () => {
    void issuer.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
