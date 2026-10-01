import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Button, Cluster, Link, Stack } from '@d3cloud/ui';
import { describeError } from '../../api';
import { deviceApi, type MailSettings, type ProfileLink } from './api';
import { DeviceQr } from './DeviceQr';
import { ConnectionStatus } from './FirstUse';
import { ServerSettingsList } from './ServerSettings';

/** Runs an action that may need a fresh step-up; DeviceSetup asks for the code and runs it again. */
export type WithStepUp = (action: () => Promise<void>) => Promise<void>;

/** Triggers a browser download of a Blob without ever navigating away from this screen. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function useExpired(expiresAt: string | null): boolean {
  const [expired, setExpired] = useState<string | null>(null);
  useEffect(() => {
    if (expiresAt === null) return undefined;
    const t = setTimeout(
      () => {
        setExpired(expiresAt);
      },
      Math.max(0, new Date(expiresAt).getTime() - Date.now()),
    );
    return () => {
      clearTimeout(t);
    };
  }, [expiresAt]);
  return expiresAt !== null && expired === expiresAt;
}

/**
 * iPhone: a QR code of a one-time URL. The camera opens it in Safari, which downloads the profile;
 * the app password inside is minted at that moment, and the URL answers 410 from then on.
 */
export function IphonePanel({ withStepUp }: { withStepUp: WithStepUp }) {
  const [link, setLink] = useState<ProfileLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = useExpired(link?.expiresAt ?? null);

  const make = () => {
    setError(null);
    setBusy(true);
    void withStepUp(async () => {
      setLink(await deviceApi.createLink());
    })
      .catch((caught: unknown) => {
        setError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Stack gap="16">
      <p>One profile sets up Mail, Calendar and Contacts on your iPhone, with its own app password.</p>
      {error === null ? null : (
        <Alert tone="danger" title="Couldn’t make a code">
          {error}
        </Alert>
      )}
      {link === null ? (
        <Cluster>
          <Button variant="primary" loading={busy} onClick={make}>
            Show QR code
          </Button>
        </Cluster>
      ) : (
        <Stack gap="12">
          {expired ? (
            <p>This code has expired. Make a new one when your iPhone is to hand.</p>
          ) : (
            <>
              <DeviceQr url={link.url} />
              <p>Scan with your iPhone’s camera, then tap the banner to open it. It works once, for 10 minutes.</p>
              <p>
                On your iPhone already?{' '}
                <Link href={link.url} data-testid="open-on-device">
                  Open on this device
                </Link>
              </p>
            </>
          )}
          <ConnectionStatus key={link.linkId} watch={{ kind: 'link', linkId: link.linkId, expiresAt: link.expiresAt }} waiting="Waiting for your iPhone to open the code." />
          <Cluster>
            <Button loading={busy} onClick={make}>
              Make a new code
            </Button>
          </Cluster>
        </Stack>
      )}
    </Stack>
  );
}

/** Mac: the same profile, downloaded here and opened in System Settings. */
export function MacPanel({ withStepUp }: { withStepUp: WithStepUp }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ signed: boolean; appPasswordId: string | null } | null>(null);

  const download = () => {
    setError(null);
    setBusy(true);
    void withStepUp(async () => {
      const { blob, filename, signed, appPasswordId } = await deviceApi.downloadProfile();
      downloadBlob(blob, filename);
      setDone({ signed, appPasswordId });
    })
      .catch((caught: unknown) => {
        setError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Stack gap="16">
      <p>Download a profile that sets up Mail, Calendar and Contacts on this Mac, with its own app password.</p>
      {error === null ? null : (
        <Alert tone="danger" title="Couldn’t make the profile">
          {error}
        </Alert>
      )}
      {done === null ? null : (
        <Alert tone="info" dynamic>
          {done.signed
            ? 'Downloaded. Open it, then install it in System Settings › General › Device Management. It shows as Verified.'
            : 'Downloaded. Open it, then install it in System Settings › General › Device Management. It shows as Unverified because this server has no signing certificate yet, but it works the same.'}
        </Alert>
      )}
      <Cluster>
        <Button variant={done === null ? 'primary' : 'secondary'} loading={busy} onClick={download}>
          {done === null ? 'Download profile' : 'Download another'}
        </Button>
      </Cluster>
      {done === null || done.appPasswordId === null ? null : (
        <ConnectionStatus key={done.appPasswordId} watch={{ kind: 'password', id: done.appPasswordId }} waiting="Waiting for Mail to sign in." />
      )}
    </Stack>
  );
}

const DEVICES_PATH = '/settings/security/devices';

/** Thunderbird: its own autoconfig fills in the servers from the address. */
export function ThunderbirdPanel({ settings }: { settings: MailSettings | null }) {
  return (
    <Stack gap="12">
      <p>
        In Thunderbird, choose <strong>New › Existing Mail Account</strong>, then enter your name, {settings === null || settings.address === null ? 'your address' : <code>{settings.address}</code>} and an app
        password. Thunderbird finds the servers by itself.
      </p>
      <p>
        <Link asChild>
          <RouterLink to={DEVICES_PATH}>Create an app password</RouterLink>
        </Link>
      </p>
    </Stack>
  );
}

/** Any other mail app: the settings by hand, each with Copy. */
export function OtherPanel({ settings, error }: { settings: MailSettings | null; error: string | null }) {
  return (
    <Stack gap="12">
      <p>
        Add the account by hand with these settings, and sign in with an app password.{' '}
        <Link asChild>
          <RouterLink to={DEVICES_PATH}>Create an app password</RouterLink>
        </Link>
      </p>
      {error !== null ? (
        <Alert tone="danger" title="Couldn’t load the server settings">
          {error}
        </Alert>
      ) : settings === null ? null : (
        <ServerSettingsList settings={settings} />
      )}
    </Stack>
  );
}
