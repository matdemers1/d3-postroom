// PST-REQ-085: the committed openapi.json is exactly what the request/response schemas generate, and
// a schema changed without regenerating is caught — both in memory and by the CI command itself.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MessageSummary } from '../../src/mail/schemas.js';
import { buildOpenApiDocument, COMPONENTS, ROUTES, serializeSpec, specDrift } from '../../src/openapi/document.js';

const exec = promisify(execFile);
const apiDir = fileURLToPath(new URL('../..', import.meta.url));
const specPath = join(apiDir, 'openapi.json');

describe('OpenAPI generation (PST-REQ-085)', () => {
  it('the committed spec is what the schemas generate now', async () => {
    const committed = await readFile(specPath, 'utf8');
    expect(specDrift(committed, serializeSpec(buildOpenApiDocument()))).toBeNull();
  });

  it('is deterministic', () => {
    expect(serializeSpec(buildOpenApiDocument())).toBe(serializeSpec(buildOpenApiDocument()));
  });

  it('describes every mail route, with request schemas from the validators', () => {
    const doc = buildOpenApiDocument() as { openapi: string; paths: Record<string, Record<string, { parameters?: { name: string; in: string }[]; requestBody?: unknown }>> };
    expect(doc.openapi).toMatch(/^3\.1\./);
    const ops = Object.entries(doc.paths).flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`));
    expect(ops.sort()).toEqual(
      [
        'GET /api/events',
        // PST-T-5.7: masked aliases.
        'GET /api/aliases',
        'POST /api/aliases',
        'POST /api/aliases/{id}/kill',
        'POST /api/aliases/{id}/revive',
        'GET /api/export/{id}',
        'GET /api/export/{id}/download',
        'GET /api/mailboxes',
        'GET /api/mailboxes/{id}/messages',
        'GET /api/messages/{id}',
        'GET /api/messages/{id}/attachments/{partId}',
        'GET /api/messages/{id}/body',
        'GET /api/messages/{id}/raw',
        // PST-T-6.1: the Inspect drawer.
        'GET /api/messages/{id}/inspect',
        'GET /api/messages/{id}/render',
        // PST-T-6.7: the reading pane's delivery timeline link.
        'GET /api/messages/{id}/outbound',
        'GET /api/search',
        'GET /api/senders/{address}/pin',
        'GET /api/senders/{address}/profile',
        'GET /api/threads/{id}',
        'PATCH /api/messages/{id}',
        'POST /api/export',
        'PUT /api/senders/{address}/pin',
        'DELETE /api/senders/{address}/pin',
        'POST /api/senders/{address}/screen',
        // PST-T-5.6: one-click unsubscribe (RFC 8058).
        'POST /api/messages/{id}/unsubscribe',
        // PST-T-3.11: the composer.
        'POST /api/compose/send',
        'GET /api/compose/drafts',
        'POST /api/compose/drafts',
        'GET /api/compose/drafts/{id}',
        'PUT /api/compose/drafts/{id}',
        'DELETE /api/compose/drafts/{id}',
        // PST-T-9.1: held sends (undo / scheduled) and snooze.
        'GET /api/compose/pending',
        'POST /api/compose/pending/{id}/undo',
        'PATCH /api/compose/pending/{id}',
        'POST /api/threads/{id}/snooze',
        'DELETE /api/threads/{id}/snooze',
        // PST-T-8.6: the signed .mobileconfig.
        'POST /api/mobileconfig',
        // PST-T-9.5: Sieve scripts for the rules builder.
        'GET /api/sieve/scripts',
        'GET /api/sieve/scripts/{name}',
        'PUT /api/sieve/scripts/{name}',
        'DELETE /api/sieve/scripts/{name}',
        'POST /api/sieve/scripts/{name}/activate',
        'POST /api/sieve/deactivate',
        'POST /api/sieve/check',
        // PST-T-8.5: calendar and contacts.
        'GET /api/calendar/calendars',
        'GET /api/calendar/events',
        'POST /api/calendar/calendars/{calendarId}/events',
        'GET /api/calendar/calendars/{calendarId}/events/{name}',
        'PUT /api/calendar/calendars/{calendarId}/events/{name}',
        'DELETE /api/calendar/calendars/{calendarId}/events/{name}',
        'PUT /api/calendar/calendars/{calendarId}/events/{name}/instances/{recurrenceId}',
        'DELETE /api/calendar/calendars/{calendarId}/events/{name}/instances/{recurrenceId}',
        'GET /api/contacts/address-books',
        'GET /api/contacts',
        'GET /api/contacts/lookup',
        'POST /api/contacts/address-books/{addressBookId}/cards',
        'GET /api/contacts/address-books/{addressBookId}/cards/{name}',
        'PUT /api/contacts/address-books/{addressBookId}/cards/{name}',
        'DELETE /api/contacts/address-books/{addressBookId}/cards/{name}',
        // PST-T-9.2: read receipts (MDN) and compose templates.
        'POST /api/messages/{id}/mdn',
        'GET /api/templates',
        'GET /api/templates/{id}',
        'POST /api/templates',
        'PUT /api/templates/{id}',
        'DELETE /api/templates/{id}',
        // PST-T-8.4: iMIP invitations.
        'GET /api/messages/{id}/invite',
        'POST /api/messages/{id}/invite/respond',
        'POST /api/messages/{id}/invite/remove',
        // PST-T-12.2: OpenPGP keys and S/MIME certificates.
        'GET /api/keys',
        'POST /api/keys/generate',
        'POST /api/keys/import',
        'GET /api/keys/{id}/export',
        'POST /api/keys/{id}/export-secret',
        'POST /api/keys/{id}/revoke',
        'DELETE /api/keys/{id}',
        // PST-T-4.8: the DNS checker and the setup wizard.
        'GET /api/admin/dns',
        'GET /api/admin/setup-wizard',
        'POST /api/admin/setup-wizard/domain',
        'POST /api/admin/setup-wizard/dkim',
        'POST /api/admin/setup-wizard/dns',
        'POST /api/admin/setup-wizard/mailbox',
        'POST /api/admin/setup-wizard/test',
        'POST /api/admin/setup-wizard/complete',
      ].sort(),
    );
    expect(doc.paths['/api/mailboxes/{id}/messages']?.['get']?.parameters?.map((p) => `${p.in}:${p.name}`)).toEqual(['path:id', 'query:cursor', 'query:limit']);
    expect(doc.paths['/api/messages/{id}']?.['patch']?.requestBody).toBeDefined();
  });

  it('a response schema changed without regenerating is drift', async () => {
    const committed = await readFile(specPath, 'utf8');
    const mutated = { ...COMPONENTS, MessageSummary: MessageSummary.extend({ snippet: z.string() }) };
    const generated = serializeSpec(buildOpenApiDocument(ROUTES, mutated));
    expect(generated).toContain('"snippet"');
    expect(specDrift(committed, generated)).not.toBeNull();
  });

  it('a request validator changed without regenerating is drift', async () => {
    const committed = await readFile(specPath, 'utf8');
    const routes = ROUTES.map((r) =>
      r.operationId === 'listMessages' ? { ...r, query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(50) }) } : r,
    );
    expect(specDrift(committed, serializeSpec(buildOpenApiDocument(routes)))).not.toBeNull();
  });

  it('openapi:check exits 0 on the committed spec and 1 on a stale one', async () => {
    const run = (args: string[]) =>
      exec(process.execPath, ['--conditions=source', '--import', 'tsx', 'src/openapi/generate.ts', '--check', ...args], { cwd: apiDir }).then(
        (r) => ({ code: 0, ...r }),
        (e: unknown) => e as { code: number; stdout: string; stderr: string },
      );
    expect((await run([])).code).toBe(0);

    const dir = await mkdtemp(join(tmpdir(), 'pst-openapi-test-'));
    try {
      const stale = join(dir, 'openapi.json');
      // The committed file as it would be if someone had added a field to a schema and not regenerated.
      const doc = JSON.parse(await readFile(specPath, 'utf8')) as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } };
      const summary = doc.components.schemas['MessageSummary'];
      if (summary === undefined) throw new Error('MessageSummary component missing');
      delete summary.properties['bucket'];
      await writeFile(stale, serializeSpec(doc));
      const result = await run(['--against', stale]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('drifted');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
