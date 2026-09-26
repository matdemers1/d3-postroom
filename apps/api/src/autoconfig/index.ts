// Mail client autoconfiguration (PST-T-3.6): Thunderbird autoconfig and Outlook/Apple autodiscover.
// Public (no session, no CSRF), mounted by app.ts at the site root before the SPA fallback.
//
// Thunderbird tries, in order: https://autoconfig.<domain>/mail/config-v1.1.xml, then
// https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml, both with ?emailaddress=. Outlook
// (and Apple Mail) POST a small XML "POX" request to /autodiscover/autodiscover.xml and sometimes
// probe it with GET first.
import { Router, type Request, type Response } from 'express';
import { normalizeDomain, parseAddress } from '@postroom/db';
import { handle } from '../auth/middleware.js';
import type { ApiDeps } from '../deps.js';

const MAX_AUTODISCOVER_BODY = 16 * 1024;

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

/** Best-effort domain the client is asking about: the ?emailaddress= param first, else the Host. */
function domainFromRequest(req: Request): string | undefined {
  const raw = req.query['emailaddress'];
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      return parseAddress(raw).domain;
    } catch {
      return undefined;
    }
  }
  const host = req.hostname;
  const stripped = host.startsWith('autoconfig.') ? host.slice('autoconfig.'.length) : host;
  try {
    return normalizeDomain(stripped);
  } catch {
    return undefined;
  }
}

function thunderbirdConfigXml(domain: string, imapHost: string, submissionHost: string, docBase: string): string {
  const d = escapeXml(domain);
  const imap = escapeXml(imapHost);
  const smtp = escapeXml(submissionHost);
  const docUrl = escapeXml(`${docBase}/help`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${d}">
    <domain>${d}</domain>
    <displayName>Postroom</displayName>
    <displayShortName>Postroom</displayShortName>
    <incomingServer type="imap">
      <hostname>${imap}</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${smtp}</hostname>
      <port>465</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
    <outgoingServer type="smtp">
      <hostname>${smtp}</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
    <documentation url="${docUrl}">
      <descr lang="en">Postroom webmail and mail settings</descr>
    </documentation>
  </emailProvider>
</clientConfig>
`;
}

function autodiscoverXml(email: string, imapHost: string, submissionHost: string): string {
  const e = escapeXml(email);
  const imap = escapeXml(imapHost);
  const smtp = escapeXml(submissionHost);
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${imap}</Server>
        <Port>993</Port>
        <SSL>on</SSL>
        <LoginName>${e}</LoginName>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${smtp}</Server>
        <Port>465</Port>
        <SSL>on</SSL>
        <LoginName>${e}</LoginName>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>
`;
}

/** Reads the raw request body up to `limit` bytes, rejecting anything larger. */
async function readRawBody(req: Request, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (error: Error): void => {
      if (done) return;
      done = true;
      reject(error);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Reject without tearing down the socket: the caller still needs to read a 400 response.
        fail(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

const EMAIL_ELEMENT = /<EMailAddress>\s*([^<>&]+?)\s*<\/EMailAddress>/i;

/** Strict, allocation-free extraction of the one field Postroom needs — never a real XML parser. */
function extractEmailAddress(body: string): string | undefined {
  if (/<!doctype/i.test(body) || /<!entity/i.test(body) || body.includes('<!--')) return undefined;
  const match = EMAIL_ELEMENT.exec(body);
  return match?.[1];
}

export function autoconfigRoutes(deps: ApiDeps): Router {
  const router = Router();
  const imapHost = deps.env['IMAP_HOSTNAME'] ?? 'mx.d3cloud.io';
  const submissionHost = deps.env['SUBMISSION_HOSTNAME'] ?? 'mx.d3cloud.io';

  const serveThunderbirdConfig = handle(async (req: Request, res: Response): Promise<void> => {
    const domain = domainFromRequest(req);
    if (domain === undefined) {
      res.status(404).end();
      return;
    }
    const found = await deps.db.domain.findFirst({ where: { name: domain } });
    if (found === null) {
      res.status(404).end();
      return;
    }
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(thunderbirdConfigXml(domain, imapHost, submissionHost, deps.config.webOrigin));
  });

  router.get('/.well-known/autoconfig/mail/config-v1.1.xml', serveThunderbirdConfig);
  router.get('/mail/config-v1.1.xml', serveThunderbirdConfig);

  router.post(
    '/autodiscover/autodiscover.xml',
    handle(async (req: Request, res: Response): Promise<void> => {
      let body: string;
      try {
        body = await readRawBody(req, MAX_AUTODISCOVER_BODY);
      } catch {
        res.status(400).end();
        return;
      }
      const emailRaw = extractEmailAddress(body);
      if (emailRaw === undefined) {
        res.status(400).end();
        return;
      }
      let parsed;
      try {
        parsed = parseAddress(emailRaw);
      } catch {
        res.status(400).end();
        return;
      }
      const found = await deps.db.domain.findFirst({ where: { name: parsed.domain } });
      if (found === null) {
        res.status(404).end();
        return;
      }
      res.set('Content-Type', 'application/xml; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.send(autodiscoverXml(`${parsed.localPart}@${parsed.domain}`, imapHost, submissionHost));
    }),
  );
  // Some clients probe the endpoint with a plain GET before POSTing the real request; answer the
  // same document when an address is already known (e.g. ?emailaddress=), otherwise 404.
  router.get(
    '/autodiscover/autodiscover.xml',
    handle(async (req: Request, res: Response): Promise<void> => {
      const raw = req.query['emailaddress'];
      if (typeof raw !== 'string' || raw.length === 0) {
        res.status(404).end();
        return;
      }
      let parsed;
      try {
        parsed = parseAddress(raw);
      } catch {
        res.status(400).end();
        return;
      }
      const found = await deps.db.domain.findFirst({ where: { name: parsed.domain } });
      if (found === null) {
        res.status(404).end();
        return;
      }
      res.set('Content-Type', 'application/xml; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.send(autodiscoverXml(`${parsed.localPart}@${parsed.domain}`, imapHost, submissionHost));
    }),
  );

  return router;
}
