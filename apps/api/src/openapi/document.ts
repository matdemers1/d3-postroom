// The OpenAPI 3.1 document, generated from the zod schemas the routes validate with (PST-REQ-085).
// OpenAPI 3.1 uses JSON Schema 2020-12, which is what `z.toJSONSchema()` emits, so no translation
// layer sits between what the server checks and what the spec says.
//
// Named response/event schemas become components (via a zod registry, so shared shapes are $refs);
// params, queries and request bodies are emitted inline in their *input* form (defaults optional).
// `serializeSpec` is deterministic: the same schemas always give byte-identical JSON, which is what
// lets `openapi:check` fail CI on any drift.
import { z } from 'zod';
import { SESSION_COOKIE } from '../auth/sessions.js';
import * as S from '../mail/schemas.js';
import * as E from '../export/schemas.js';
import * as SP from '../senders/schemas.js';
import { COMPOSE_COMPONENTS, COMPOSE_ROUTES } from '../compose/openapi.js';
import { MOBILECONFIG_ROUTES } from '../mobileconfig/openapi.js';
import { SIEVE_COMPONENTS, SIEVE_ROUTES } from '../sieve/openapi.js';
import { CALENDAR_COMPONENTS, CALENDAR_ROUTES } from '../calendar/openapi.js';
import { CONTACTS_COMPONENTS, CONTACTS_ROUTES } from '../contacts/openapi.js';

type Json = Record<string, unknown>;

export interface ResponseSpec {
  description: string;
  /** A component name, for JSON bodies. */
  schema?: string;
  /** Non-JSON bodies, by media type (e.g. text/event-stream). */
  content?: Record<string, Json>;
  headers?: Record<string, Json>;
}

export interface RouteSpec {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** OpenAPI path, `{param}` style. */
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  description?: string;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  headers?: { name: string; required: boolean; description: string }[];
  responses: Record<string, ResponseSpec>;
}

/** Every schema published under components.schemas, by name. */
export const COMPONENTS: Record<string, z.ZodType> = {
  Error: S.ErrorBody,
  Mailbox: S.Mailbox,
  MailboxList: S.MailboxList,
  MessageSummary: S.MessageSummary,
  MessageList: S.MessageList,
  MessageDetail: S.MessageDetail,
  Attachment: S.Attachment,
  MessageBody: S.MessageBody,
  RenderTicket: S.RenderTicket,
  ThreadDetail: S.ThreadDetail,
  SearchResponse: S.SearchResponse,
  MailboxChangedEvent: S.MailboxChangedEvent,
  MessageNewEvent: S.MessageNewEvent,
  ExportStatus: E.ExportStatus,
  SenderPin: SP.SenderPinView,
  SenderScreenResult: SP.SenderScreenResult,
  ...COMPOSE_COMPONENTS,
  ...SIEVE_COMPONENTS,
  ...CALENDAR_COMPONENTS,
  ...CONTACTS_COMPONENTS,
};

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const COMMON = { '401': err('No session.'), '400': err('The request failed validation.') };
const ETAG = { ETag: { description: 'The message MODSEQ, quoted: "<modseq>".', schema: { type: 'string' } } };

export const ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/mailboxes',
    operationId: 'listMailboxes',
    tag: 'Mailboxes',
    summary: "The caller's mailboxes with counters.",
    responses: { '200': { description: 'Mailboxes, INBOX first.', schema: 'MailboxList' }, '401': err('No session.') },
  },
  {
    method: 'get',
    path: '/api/mailboxes/{id}/messages',
    operationId: 'listMessages',
    tag: 'Mailboxes',
    summary: 'One page of a mailbox, newest UID first.',
    params: S.IdParams,
    query: S.MessageListQuery,
    responses: { '200': { description: 'A page; nextCursor is null on the last.', schema: 'MessageList' }, ...COMMON, '404': err('Not a mailbox of the caller.') },
  },
  {
    method: 'get',
    path: '/api/messages/{id}',
    operationId: 'getMessage',
    tag: 'Messages',
    summary: 'One message: summary, threading headers and verdict.',
    params: S.IdParams,
    responses: { '200': { description: 'The message.', schema: 'MessageDetail', headers: ETAG }, ...COMMON, '404': err('Not a message of the caller.') },
  },
  {
    method: 'patch',
    path: '/api/messages/{id}',
    operationId: 'updateMessage',
    tag: 'Messages',
    summary: 'Add/remove flags and/or move to another mailbox.',
    description:
      'Requires If-Match with the ETag from GET. A move creates the message in the target with a new UID (and a new id), removes it from the source, and bumps both mailboxes\' HIGHESTMODSEQ. Audited. Needs x-postroom-csrf: 1.',
    params: S.IdParams,
    body: S.MessagePatch,
    headers: [
      { name: 'If-Match', required: true, description: 'The ETag of the version being changed, or *.' },
      { name: 'x-postroom-csrf', required: true, description: 'Must be 1.' },
    ],
    responses: {
      '200': { description: 'The message after the change (a new id after a move).', schema: 'MessageDetail', headers: ETAG },
      ...COMMON,
      '403': err('Missing CSRF header.'),
      '404': err('Not a message (or target mailbox) of the caller.'),
      '412': { description: 'If-Match is stale; the current ETag is returned.', schema: 'Error', headers: ETAG },
      '428': err('If-Match missing.'),
    },
  },
  {
    method: 'get',
    path: '/api/messages/{id}/raw',
    operationId: 'getMessageRaw',
    tag: 'Messages',
    summary: 'The RFC 5322 source, streamed as a text/plain download.',
    params: S.IdParams,
    responses: {
      '200': { description: 'The message source.', content: { 'text/plain': { schema: { type: 'string' } } } },
      ...COMMON,
      '404': err('Not a message of the caller.'),
    },
  },
  {
    method: 'get',
    path: '/api/messages/{id}/body',
    operationId: 'getMessageBody',
    tag: 'Messages',
    summary: 'The parsed message: headers, text, raw html and the attachment list.',
    params: S.IdParams,
    responses: { '200': { description: 'The parsed body.', schema: 'MessageBody' }, ...COMMON, '404': err('Not a message of the caller.') },
  },
  {
    method: 'get',
    path: '/api/messages/{id}/render',
    operationId: 'renderMessage',
    tag: 'Messages',
    summary: 'A short-lived URL of the sanitised HTML on the usercontent origin (PST-REQ-081).',
    description:
      'The usercontent origin has no session cookie, so this mints a capability for one message of the caller, under the caller\'s session, valid for 15 minutes. Remote images stay blocked unless images=1, and then load only through the image proxy (PST-REQ-082). Frame the URL with sandbox and no allow-scripts/allow-same-origin.',
    params: S.IdParams,
    query: S.RenderQuery,
    responses: {
      '200': { description: 'The render ticket.', schema: 'RenderTicket' },
      ...COMMON,
      '404': err('Not a message of the caller.'),
      '503': err('USERCONTENT_ORIGIN (or POSTROOM_KEK) is not set.'),
    },
  },
  {
    method: 'get',
    path: '/api/messages/{id}/attachments/{partId}',
    operationId: 'getAttachment',
    tag: 'Messages',
    summary: 'One MIME leaf part, decoded and streamed as a download (never inline).',
    params: S.AttachmentParams,
    responses: {
      '200': {
        description: 'application/octet-stream with Content-Disposition: attachment; the declared type is in X-Postroom-Content-Type.',
        content: { 'application/octet-stream': { schema: { type: 'string', contentEncoding: 'binary' } } },
      },
      ...COMMON,
      '404': err('No such message or leaf part.'),
    },
  },
  {
    method: 'get',
    path: '/api/threads/{id}',
    operationId: 'getThread',
    tag: 'Threads',
    summary: "A thread and the caller's messages in it, oldest first.",
    params: S.IdParams,
    responses: { '200': { description: 'The thread.', schema: 'ThreadDetail' }, ...COMMON, '404': err('Not a thread of the caller.') },
  },
  {
    method: 'get',
    path: '/api/search',
    operationId: 'search',
    tag: 'Search',
    summary: 'Full-text search over the caller’s mail (PST-REQ-080).',
    query: S.SearchQuery,
    responses: { '200': { description: 'Matching messages, best rank first.', schema: 'SearchResponse' }, ...COMMON, '404': err('mailboxId is not the caller’s.') },
  },
  {
    method: 'post',
    path: '/api/export',
    operationId: 'startExport',
    tag: 'Export',
    summary: 'Start a full-data export of the caller\'s account: mbox per folder + manifest.json in a ZIP (PST-REQ-151).',
    description:
      'Needs a fresh step-up and x-postroom-csrf: 1. One active export per account: a second call while one is pending or running is 409. The archive is deleted 24 h after it finishes.',
    headers: [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }],
    responses: {
      '202': { description: 'The export, just started.', schema: 'ExportStatus' },
      ...COMMON,
      '403': err('Missing CSRF header, or step-up required.'),
      '409': err('An export is already pending or running for this account.'),
    },
  },
  {
    method: 'get',
    path: '/api/export/{id}',
    operationId: 'getExportStatus',
    tag: 'Export',
    summary: 'The status of one export of the caller\'s.',
    params: E.IdParams,
    responses: { '200': { description: 'pending | running | done | failed.', schema: 'ExportStatus' }, ...COMMON, '404': err('Not an export of the caller.') },
  },
  {
    method: 'get',
    path: '/api/export/{id}/download',
    operationId: 'downloadExport',
    tag: 'Export',
    summary: 'The finished archive, streamed as application/zip.',
    description: 'Needs a fresh step-up. 409 while the export is still pending/running; 404 once done but past its 24 h expiry (the archive was swept).',
    params: E.IdParams,
    responses: {
      '200': { description: 'The ZIP archive.', content: { 'application/zip': { schema: { type: 'string', contentEncoding: 'binary' } } } },
      ...COMMON,
      '403': err('Step-up required.'),
      '404': err('Not an export of the caller, or the archive has expired.'),
      '409': err('The export is not finished yet.'),
    },
  },
  {
    method: 'get',
    path: '/api/events',
    operationId: 'events',
    tag: 'Events',
    summary: 'Live updates as server-sent events.',
    description:
      'Starts with one mailbox.changed per mailbox, then message.new (MessageNewEvent) and mailbox.changed (MailboxChangedEvent) as mail arrives or changes. A comment heartbeat every 25 s. Only the caller\'s mailboxes.',
    responses: {
      '200': { description: 'An event stream.', content: { 'text/event-stream': { schema: { type: 'string' } } } },
      '401': err('No session.'),
      '503': err('Events are not configured.'),
    },
  },
  {
    method: 'get',
    path: '/api/senders/{address}/pin',
    operationId: 'getSenderPin',
    tag: 'Senders',
    summary: 'The caller\'s pin for this sender address, if any (PST-REQ-105).',
    params: SP.AddressParam,
    responses: { '200': { description: 'The pin (bucket is null when there is none).', schema: 'SenderPin' }, ...COMMON },
  },
  {
    method: 'put',
    path: '/api/senders/{address}/pin',
    operationId: 'setSenderPin',
    tag: 'Senders',
    summary: 'Pin this sender to a bucket — overrides the classifier for their mail (PST-REQ-105).',
    description: 'A pin into Priority or People still requires the message to authenticate, exactly like the VIP rule. Audited. Needs x-postroom-csrf: 1.',
    params: SP.AddressParam,
    body: SP.SenderPinBody,
    headers: [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }],
    responses: { '200': { description: 'The pin after the change.', schema: 'SenderPin' }, ...COMMON, '403': err('Missing CSRF header.') },
  },
  {
    method: 'delete',
    path: '/api/senders/{address}/pin',
    operationId: 'clearSenderPin',
    tag: 'Senders',
    summary: 'Remove the bucket pin for this sender (a screen decision, if any, is unaffected).',
    description: 'Audited. Needs x-postroom-csrf: 1.',
    params: SP.AddressParam,
    headers: [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }],
    responses: { '200': { description: 'ok: true.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true } } } } } }, ...COMMON, '403': err('Missing CSRF header.') },
  },
  {
    method: 'post',
    path: '/api/senders/{address}/screen',
    operationId: 'screenSender',
    tag: 'Senders',
    summary: "Answer this sender's new-sender badge: Allow or Block (PST-REQ-106).",
    description:
      'Allow treats the sender as a known contact, so a directly-addressed message from them can reach Priority. Block routes their future mail to Junk. Either clears the $NewSender badge on their already-filed mail. Audited. Needs x-postroom-csrf: 1.',
    params: SP.AddressParam,
    body: SP.SenderScreenBody,
    headers: [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }],
    responses: { '200': { description: 'The screen decision after the change.', schema: 'SenderScreenResult' }, ...COMMON, '403': err('Missing CSRF header.') },
  },
  ...COMPOSE_ROUTES,
  ...MOBILECONFIG_ROUTES,
  ...SIEVE_ROUTES,
  ...CALENDAR_ROUTES,
  ...CONTACTS_ROUTES,
];

function strip(schema: Json): Json {
  const out: Json = { ...schema };
  delete out['$schema'];
  delete out['$id'];
  return out;
}

function inputSchema(schema: z.ZodType): Json {
  return strip(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
}

function componentSchemas(components: Record<string, z.ZodType>): Record<string, Json> {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries(components)) registry.add(schema, { id: name });
  const out = z.toJSONSchema(registry, { uri: (id) => `#/components/schemas/${id}`, unrepresentable: 'any' }) as { schemas: Record<string, Json> };
  const sorted: Record<string, Json> = {};
  for (const name of Object.keys(out.schemas).sort()) {
    const schema = out.schemas[name];
    if (schema !== undefined) sorted[name] = strip(schema);
  }
  return sorted;
}

function parameters(route: RouteSpec): Json[] {
  const out: Json[] = [];
  const add = (where: 'path' | 'query', obj: z.ZodObject | undefined): void => {
    if (obj === undefined) return;
    const json = inputSchema(obj) as { properties?: Record<string, Json>; required?: string[] };
    for (const [name, schema] of Object.entries(json.properties ?? {})) {
      const description = typeof schema['description'] === 'string' ? schema['description'] : undefined;
      out.push({
        name,
        in: where,
        required: where === 'path' || (json.required ?? []).includes(name),
        ...(description !== undefined ? { description } : {}),
        schema,
      });
    }
  };
  add('path', route.params);
  add('query', route.query);
  for (const h of route.headers ?? []) out.push({ name: h.name, in: 'header', required: h.required, description: h.description, schema: { type: 'string' } });
  return out;
}

function responses(route: RouteSpec): Json {
  const out: Json = {};
  for (const code of Object.keys(route.responses).sort()) {
    const r = route.responses[code];
    if (r === undefined) continue;
    const content = r.schema !== undefined ? { 'application/json': { schema: { $ref: `#/components/schemas/${r.schema}` } } } : r.content;
    out[code] = { description: r.description, ...(r.headers !== undefined ? { headers: r.headers } : {}), ...(content !== undefined ? { content } : {}) };
  }
  return out;
}

export function buildOpenApiDocument(routes: readonly RouteSpec[] = ROUTES, components: Record<string, z.ZodType> = COMPONENTS): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const route of [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
    for (const r of Object.values(route.responses)) {
      if (r.schema !== undefined && !(r.schema in components)) throw new Error(`${route.operationId}: unknown component ${r.schema}`);
    }
    const op: Json = {
      operationId: route.operationId,
      tags: [route.tag],
      summary: route.summary,
      ...(route.description !== undefined ? { description: route.description } : {}),
    };
    const params = parameters(route);
    if (params.length > 0) op['parameters'] = params;
    if (route.body !== undefined) op['requestBody'] = { required: true, content: { 'application/json': { schema: inputSchema(route.body) } } };
    op['responses'] = responses(route);
    (paths[route.path] ??= {})[route.method] = op;
  }
  return {
    openapi: '3.1.1',
    info: {
      title: 'Postroom API',
      version: '0.1.0',
      description: 'REST/JSON under /api for the Postroom webmail. Generated from the zod schemas that validate requests (PST-REQ-085); regenerate with `pnpm --filter @postroom/api openapi`.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: '/' }],
    components: {
      schemas: componentSchemas(components),
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE } },
    },
    security: [{ session: [] }],
    paths,
  };
}

/** Stable text: 2-space JSON and a trailing newline. */
export function serializeSpec(doc: Json): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** null when `committed` matches what the schemas generate now; otherwise a short description of the first difference. */
export function specDrift(committed: string, generated: string): string | null {
  if (committed === generated) return null;
  const a = committed.split('\n');
  const b = generated.split('\n');
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return `line ${i + 1}:\n  committed: ${a[i] ?? '<end of file>'}\n  generated: ${b[i] ?? '<end of file>'}`;
  }
  return 'files differ';
}
