// The usercontent origin (PST-REQ-081, PST-REQ-082). Mail HTML is rendered here and nowhere else:
// a separate origin (USERCONTENT_ORIGIN, e.g. https://usercontent.d3cloud.io) served by the same api
// process, chosen by the request's Host header. It has no session cookie and no route of the mail
// app — only these:
//
//   GET  /m/:token             the sanitised message as a document, under a CSP with no script-src,
//                              `sandbox`, and frame-ancestors = the mail origin only
//   GET  /m/:token/cid/:cid    an image part of that same message (cid: references)
//   GET  /img?u=&t=&s=         the image proxy, for a token minted with images=1 and a URL the
//                              sanitizer signed into that very render
//   POST /csp-report           CSP violation reports, logged (there should never be one)
//
// The frame in the web app is <iframe sandbox="allow-popups allow-popups-to-escape-sandbox"> — no
// allow-scripts, no allow-same-origin — and this response's CSP sandbox says the same, so even a
// top-level visit to /m/… runs no script and has an opaque origin. Popups are allowed only so a link
// (always target=_blank rel=noopener noreferrer) opens in a normal tab.
//
// Nothing here writes to the database, so nothing here is audited: a render is a read.
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { collectMessage, parseMessage } from '@postroom/mime';
import express, { Router, type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import { ABSOLUTE_MS } from '../auth/sessions.js';
import type { ApiDeps } from '../deps.js';
import { DEFAULT_BLOB_ROOT } from '../mail/index.js';
import { findOwnMessage } from '../mail/store.js';
import { fetchImage, type FetchPolicy } from './proxy.js';
import { sanitizeHtml, escapeText } from './sanitize.js';
import { deriveKey, mintToken, signImage, TOKEN_TTL_S, verifyImage, verifyToken, type Capability } from './token.js';

export interface UsercontentConfig {
  /** e.g. https://usercontent.d3cloud.io — no path, no trailing slash. */
  origin: string;
  /** The Host header that selects this app (host[:port], lowercase). */
  host: string;
  /** The mail origin: the only page allowed to frame a render. */
  webOrigin: string;
  /** HMAC key for capability tokens, derived from SESSION_SECRET. */
  key: Buffer;
  proxy: FetchPolicy;
}

const configs = new WeakMap<ApiDeps, UsercontentConfig | null>();

function warn(event: string, detail: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ event, ...detail })}\n`);
}

/**
 * The usercontent configuration, or null when HTML rendering is off: USERCONTENT_ORIGIN unset or
 * not an http(s) origin, the same origin as the mail app (that would put mail HTML beside the
 * session cookie — refused), or no SESSION_SECRET to key the tokens.
 */
export function usercontentConfig(deps: ApiDeps): UsercontentConfig | null {
  if (configs.has(deps)) return configs.get(deps) ?? null;
  let config: UsercontentConfig | null = null;
  const raw = deps.env['USERCONTENT_ORIGIN']?.trim() ?? '';
  const secret = runtimeFor(deps).sessionSecret;
  if (raw !== '') {
    try {
      const url = new URL(raw);
      const web = new URL(deps.config.webOrigin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') warn('usercontent-disabled', { reason: 'USERCONTENT_ORIGIN must be http(s)' });
      else if (url.origin === web.origin || url.host === web.host) warn('usercontent-disabled', { reason: 'USERCONTENT_ORIGIN must differ from WEB_ORIGIN' });
      else if (secret === null) warn('usercontent-disabled', { reason: 'SESSION_SECRET is not set' });
      else {
        // Loopback in tests only: the e2e listener that stands in for a sender's server is local.
        const allowPrivate = deps.env['IMAGE_PROXY_ALLOW_PRIVATE'] === '1' && deps.env['POSTROOM_E2E_SEED'] === '1';
        config = { origin: url.origin, host: url.host.toLowerCase(), webOrigin: web.origin, key: deriveKey(secret), proxy: { allowPrivate } };
      }
    } catch {
      warn('usercontent-disabled', { reason: 'USERCONTENT_ORIGIN or WEB_ORIGIN is not a URL' });
    }
  }
  configs.set(deps, config);
  return config;
}

/** A render URL for one message of the caller's, valid for TOKEN_TTL_S. */
export function mintRenderUrl(config: UsercontentConfig, cap: Omit<Capability, 'exp'>, now: Date): { url: string; expiresAt: string } {
  const exp = Math.floor(now.getTime() / 1000) + TOKEN_TTL_S;
  return { url: `${config.origin}/m/${mintToken(config.key, { ...cap, exp })}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The CSP of a rendered message. No script-src at all: default-src 'none' covers it. */
export function renderCsp(config: UsercontentConfig): string {
  return [
    "default-src 'none'",
    `img-src data: cid: ${config.origin}`,
    "style-src 'unsafe-inline'",
    'font-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${config.webOrigin}`,
    'sandbox allow-popups allow-popups-to-escape-sandbox',
    `report-uri ${config.origin}/csp-report`,
  ].join('; ');
}

const IMAGE_CSP = "default-src 'none'; sandbox";

function baseHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', IMAGE_CSP);
  next();
}

/** Mail's defaults, before the sender's own styles: readable, contained, light (senders assume white). */
const BASE_STYLE =
  ':root{color-scheme:light}html{background:#fff;color:#111}body{margin:0;padding:12px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}' +
  'img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:0 0 0 8px;padding-left:8px;border-left:2px solid #ccc}';

export function renderDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_STYLE}</style></head><body>${body}</body></html>`;
}

const plainText = (text: string): string => `<pre style="font: inherit">${escapeText(text)}</pre>`;

const normalCid = (cid: string): string => cid.trim().replace(/^<|>$/g, '').toLowerCase();

const SERVED_PART_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);

export function usercontentApp(deps: ApiDeps, config: UsercontentConfig): Express {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', 1);
  app.use(baseHeaders);

  let blobs: BlobStore | null = null;
  const blobStore = (): BlobStore | null => {
    if (blobs !== null) return blobs;
    if (rt.kek === null) return null;
    const root = deps.env['BLOB_ROOT']?.trim() ?? '';
    blobs = createBlobStore({ root: root === '' ? DEFAULT_BLOB_ROOT : root, db, kek: rt.kek });
    return blobs;
  };

  const gone = (res: Response): void => {
    res.status(404).type('text/plain').send('Not found or expired. Open the message again.');
  };

  /** A live capability: a valid token AND its session still signed in AND its account enabled. */
  const capability = async (token: string): Promise<Capability | null> => {
    const now = rt.now();
    const cap = verifyToken(config.key, token, now.getTime());
    if (cap === null) return null;
    const session = await db.session.findUnique({
      where: { id: cap.sessionId },
      select: { accountId: true, createdAt: true, expiresAt: true, account: { select: { disabledAt: true } } },
    });
    if (session === null || session.accountId !== cap.accountId || session.account.disabledAt !== null) return null;
    if (session.expiresAt.getTime() <= now.getTime() || session.createdAt.getTime() + ABSOLUTE_MS <= now.getTime()) return null;
    return cap;
  };

  const ownMessage = async (token: string): Promise<{ cap: Capability; message: NonNullable<Awaited<ReturnType<typeof findOwnMessage>>> } | null> => {
    const cap = await capability(token);
    if (cap === null) return null;
    const message = await findOwnMessage(db, cap.accountId, cap.messageId);
    return message === null ? null : { cap, message };
  };

  const router = Router();

  router.get(
    '/m/:token',
    handle(async (req, res) => {
      const token = String(req.params['token']);
      const found = await ownMessage(token);
      if (found === null) {
        gone(res);
        return;
      }
      const store = blobStore();
      if (store === null) {
        res.status(503).type('text/plain').send('POSTROOM_KEK is not set.');
        return;
      }
      const summary = await collectMessage(await store.get(found.message.blobSha256));
      const base = `${config.origin}/m/${token}`;
      let body: string;
      if (summary.html !== null) {
        body = sanitizeHtml(summary.html.text, {
          cidImage: (cid) => `${base}/cid/${encodeURIComponent(normalCid(cid))}`,
          remoteImage: found.cap.images
            ? (url) => `${config.origin}/img?u=${encodeURIComponent(url)}&t=${token}&s=${signImage(config.key, token, url)}`
            : undefined,
        }).html;
      } else {
        body = plainText(summary.text?.text ?? '');
      }
      res.setHeader('Content-Security-Policy', renderCsp(config));
      res.type('text/html; charset=utf-8').send(renderDocument(body));
    }),
  );

  router.get(
    '/m/:token/cid/:cid',
    handle(async (req, res) => {
      const found = await ownMessage(String(req.params['token']));
      const store = blobStore();
      if (found === null || store === null) {
        gone(res);
        return;
      }
      const wanted = normalCid(String(req.params['cid']));
      let started = false;
      for await (const event of parseMessage(await store.get(found.message.blobSha256))) {
        if (res.destroyed) return;
        if (!started && event.type === 'headers' && event.part.kind === 'leaf' && event.part.contentId !== null && normalCid(event.part.contentId) === wanted) {
          if (!SERVED_PART_TYPES.has(event.part.contentType)) break;
          res.status(200).type(event.part.contentType);
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          started = true;
        } else if (started && event.type === 'body') {
          // Image bytes only (SERVED_PART_TYPES), on the sandboxed usercontent origin with nosniff and a
          // no-script CSP; the body is binary image data, not markup.
          // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
          if (!res.write(event.chunk)) await new Promise<void>((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
        } else if (started && event.type === 'end-part') {
          break;
        }
      }
      if (started) res.end();
      else gone(res);
    }),
  );

  router.get(
    '/img',
    handle(async (req, res) => {
      const u = typeof req.query['u'] === 'string' ? req.query['u'] : '';
      const t = typeof req.query['t'] === 'string' ? req.query['t'] : '';
      const s = typeof req.query['s'] === 'string' ? req.query['s'] : '';
      if (u === '' || !verifyImage(config.key, t, u, s)) {
        res.status(403).type('text/plain').send('Not a signed image address.');
        return;
      }
      const cap = await capability(t);
      if (cap === null || !cap.images) {
        gone(res);
        return;
      }
      const result = await fetchImage(u, config.proxy);
      if (!result.ok) {
        res.status(result.status).type('text/plain').send(`Image not loaded: ${result.reason}`);
        return;
      }
      res.status(200).type(result.contentType);
      res.setHeader('Content-Length', String(result.body.length));
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Content-Disposition', 'inline');
      // fetchImage only returns an allowlisted image/* type (proxy.ts); served with nosniff under the
      // usercontent origin's no-script CSP.
      // nosemgrep: semgrep.postroom.reflected-user-input
      res.end(result.body);
    }),
  );

  router.post(
    '/csp-report',
    express.raw({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }),
    (req, res) => {
      const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8').slice(0, 4000) : '';
      warn('usercontent-csp-violation', { report: text });
      res.status(204).end();
    },
  );

  app.use(router);
  app.use((_req, res) => {
    gone(res);
  });
  // Never the mail app's error page, never a stack.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    warn('usercontent-error', { error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) res.status(500).type('text/plain').send('Could not render this message.');
    else res.destroy();
  });
  return app;
}

/**
 * Host-based dispatch, mounted first in createApp: a request whose Host is the usercontent host is
 * answered by the usercontent app and never reaches the mail app (so no mail route, cookie or SPA is
 * ever served there); every other request passes through untouched. The raw Host header is used,
 * not X-Forwarded-Host: cloudflared forwards the original Host.
 */
export function usercontentDispatch(deps: ApiDeps): RequestHandler | null {
  const config = usercontentConfig(deps);
  if (config === null) return null;
  const app = usercontentApp(deps, config);
  return (req, res, next) => {
    if ((req.headers.host ?? '').toLowerCase() === config.host) {
      app(req, res);
      return;
    }
    next();
  };
}
