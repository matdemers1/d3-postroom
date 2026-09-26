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
        'GET /api/export/{id}',
        'GET /api/export/{id}/download',
        'GET /api/mailboxes',
        'GET /api/mailboxes/{id}/messages',
        'GET /api/messages/{id}',
        'GET /api/messages/{id}/attachments/{partId}',
        'GET /api/messages/{id}/body',
        'GET /api/messages/{id}/raw',
        'GET /api/messages/{id}/render',
        'GET /api/search',
        'GET /api/threads/{id}',
        'PATCH /api/messages/{id}',
        'POST /api/export',
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
