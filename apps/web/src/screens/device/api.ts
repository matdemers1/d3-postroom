// The Connect a device screen's calls (PST-T-16.16): the server settings a mail app needs, the
// iPhone's one-time profile link and its status, the Mac's profile download, and the app-password
// list the first-use watch reads. Built on api.ts's `call()`; the download goes around it because
// the body is a profile, not JSON.
import { CSRF_HEADER, apiErrorOf, call, parseBody, type AppPassword } from '../../api';

export interface ServerEndpoint {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
}

/** GET /api/mobileconfig/settings: the same hosts Thunderbird's autoconfig advertises. */
export interface MailSettings {
  address: string | null;
  username: string | null;
  imap: ServerEndpoint;
  smtp: ServerEndpoint[];
}

export interface ProfileLink {
  /** A one-time secret: drawn as a QR code, never stored. */
  url: string;
  linkId: string;
  expiresAt: string;
}

/** The protocol an app password was last used over, or null when the server has none recorded. */
export type UseProtocol = 'imap' | 'smtp' | 'dav' | 'sieve' | null;

export interface ProfileLinkStatus {
  redeemed: boolean;
  appPasswordId: string | null;
  lastUsedAt: string | null;
  protocol: UseProtocol;
}


export interface DownloadedProfile {
  blob: Blob;
  filename: string;
  /** Whether the server signed it: iOS and macOS show Verified rather than Unverified. */
  signed: boolean;
  /** The app password the profile carries, so the screen can watch for its first use. */
  appPasswordId: string | null;
}

const FILENAME_RE = /filename="?([^";]+)"?/;

export const deviceApi = {
  settings: () => call<MailSettings>('GET', '/api/mobileconfig/settings'),
  /** Needs a fresh step-up: throws ApiError('step_up_required') otherwise. */
  createLink: () => call<ProfileLink>('POST', '/api/mobileconfig/links'),
  linkStatus: (linkId: string) => call<ProfileLinkStatus>('GET', `/api/mobileconfig/links/${encodeURIComponent(linkId)}`),
  appPasswords: () => call<{ appPasswords: AppPassword[] }>('GET', '/api/app-passwords'),

  /** Needs a fresh step-up: throws ApiError('step_up_required') otherwise. */
  async downloadProfile(): Promise<DownloadedProfile> {
    const res = await fetch('/api/mobileconfig', {
      method: 'POST',
      headers: { [CSRF_HEADER.name]: CSRF_HEADER.value },
      credentials: 'same-origin',
    });
    if (!res.ok) throw apiErrorOf(res.status, parseBody(await res.text()));
    const disposition = res.headers.get('content-disposition') ?? '';
    return {
      blob: await res.blob(),
      filename: FILENAME_RE.exec(disposition)?.[1] ?? 'postroom.mobileconfig',
      signed: res.headers.get('x-postroom-mobileconfig-signed') === '1',
      appPasswordId: res.headers.get('x-postroom-app-password-id'),
    };
  },
};

/**
 * When the app password `id` was last used, or null — read from the caller's own list, which names
 * no protocol; only a one-time link's status does (the line then says "Connected at …").
 */
export async function passwordLastUsed(id: string): Promise<{ lastUsedAt: string | null }> {
  const { appPasswords } = await deviceApi.appPasswords();
  return { lastUsedAt: appPasswords.find((p) => p.id === id)?.lastUsedAt ?? null };
}
