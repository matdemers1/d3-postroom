/**
 * PST-T-17.17 (PST-REQ-005): the second way in, below the password form, in three states.
 *
 * - **not configured** — nothing at all: a server whose operator never set D3 Auth up should not
 *   mention it.
 * - **configured and reachable** — a bordered, full-width link. A real navigation to
 *   /api/auth/oidc/start, not a fetch: the server answers with a redirect the browser must follow.
 * - **configured but unreachable** — a dashed box with the reason and nothing to press. This is the
 *   screen someone reaches exactly when that is what is broken, so silence would read as a bug.
 */
export const D3AUTH_START = '/api/auth/oidc/start';
export const D3AUTH_LABEL = 'Sign in with D3 Auth';
export const D3AUTH_DOWN = 'D3 Auth is unreachable right now. Your password still works.';

export function SignInWithD3Auth({ configured, available }: { configured: boolean; available: boolean }) {
  if (!configured) return null;
  return (
    <div className="pr-entry-sso-group">
      <div className="pr-entry-or" aria-hidden="true">
        <span />
        or
        <span />
      </div>
      {available ? (
        <a className="pr-entry-sso" href={D3AUTH_START}>
          <KeyGlyph />
          {D3AUTH_LABEL}
        </a>
      ) : (
        <p className="pr-entry-sso pr-entry-sso--down" role="status">
          <span className="pr-entry-sso__name">
            <KeyGlyph />
            {D3AUTH_LABEL}
          </span>
          <span className="pr-entry-sso__why">{D3AUTH_DOWN}</span>
        </p>
      )}
    </div>
  );
}

function KeyGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="pr-entry-sso__glyph"
    >
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M18 12v3M15.5 12v2" />
    </svg>
  );
}
