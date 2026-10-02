// PST-T-17.17: the running build in the entry screens' footer, read from the public GET /health
// (it answers { revision, schemaRevision }). Decorative: a failure or an unbuilt server shows nothing.

/** The short revision to show, or null when there is nothing worth showing ('dev', empty, absent). */
export function buildLabel(revision: unknown): string | null {
  if (typeof revision !== 'string') return null;
  const value = revision.trim();
  if (value === '' || value === 'dev') return null;
  return value.slice(0, 7);
}

let pending: Promise<string | null> | null = null;

/**
 * The label for the server answering this page, asked once per page load: the loading state, Sign in
 * and Setup each mount the shell, and the revision does not change between them.
 */
export function fetchBuildLabel(): Promise<string | null> {
  pending ??= fetch('/health', { headers: { accept: 'application/json' }, credentials: 'same-origin' })
    .then(async (res) => {
      // A 503 still names the revision; anything that is not JSON (a dev server's index.html) is not one.
      const body = (await res.json()) as { revision?: unknown };
      return buildLabel(body.revision);
    })
    .catch(() => null);
  return pending;
}
