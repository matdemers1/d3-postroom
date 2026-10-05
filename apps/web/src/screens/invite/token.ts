// The token in an invite link (PST-T-20.2): /invite/<token> as the server mails it, or
// /invite?token=<token>. D3 Constellation recognises the same two shapes when one is pasted.
export function inviteTokenOf(pathname: string, search: string): string | null {
  const match = /^\/invite\/([A-Za-z0-9_-]{16,200})\/?$/.exec(pathname);
  if (match?.[1] !== undefined) return match[1];
  if (!/^\/invite\/?$/.test(pathname)) return null;
  const token = new URLSearchParams(search).get('token');
  return token !== null && /^[A-Za-z0-9_-]{16,200}$/.test(token) ? token : null;
}

/** Whether a path is an invite page at all (a malformed token still shows the page, to say so). */
export const isInvitePath = (pathname: string): boolean => /^\/invite(\/|$)/.test(pathname);
