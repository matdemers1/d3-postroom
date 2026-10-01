import { useEffect, useState } from 'react';
import { Alert, DescriptionItem, DescriptionList, Skeleton } from '@d3cloud/ui';
import { describeError } from '../../api';
import { CopyButton } from '../AdminDns';
import { deviceApi, type MailSettings } from './api';
import { securityLabel } from './watch';
import './device.css';

function Value({ value, label }: { value: string; label: string }) {
  return (
    <span className="pr-device-value">
      <code>{value}</code>
      <CopyButton value={value} label={label} />
    </span>
  );
}

/** The server settings block itself, for settings already loaded. */
export function ServerSettingsList({ settings }: { settings: MailSettings }) {
  return (
    <DescriptionList aria-label="Server settings" data-testid="server-settings">
      <DescriptionItem term="Incoming mail (IMAP)">
        <Value value={settings.imap.host} label="IMAP server" />
      </DescriptionItem>
      <DescriptionItem term={`IMAP port (${securityLabel(settings.imap.security)})`} numeric>
        <Value value={String(settings.imap.port)} label="IMAP port" />
      </DescriptionItem>
      {settings.smtp.length === 0 ? null : (
        <DescriptionItem term="Outgoing mail (SMTP)">
          <Value value={settings.smtp[0]?.host ?? ''} label="SMTP server" />
        </DescriptionItem>
      )}
      {settings.smtp.map((s) => (
        <DescriptionItem key={s.port} term={`SMTP port (${securityLabel(s.security)})`} numeric>
          <Value value={String(s.port)} label={`SMTP port ${String(s.port)}`} />
        </DescriptionItem>
      ))}
      <DescriptionItem term="Username">
        {settings.username === null ? 'Your full email address' : <Value value={settings.username} label="username" />}
      </DescriptionItem>
      <DescriptionItem term="Password">An app password, never your account password</DescriptionItem>
    </DescriptionList>
  );
}

/**
 * IMAP host:993, SMTP host:465 and 587, and the username, each with Copy (PST-T-16.16). Loaded from
 * the server, which reads the same hosts its Thunderbird autoconfig document advertises.
 */
export function ServerSettings() {
  const [settings, setSettings] = useState<MailSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    deviceApi
      .settings()
      .then((loaded) => {
        if (live) setSettings(loaded);
      })
      .catch((caught: unknown) => {
        if (live) setError(describeError(caught));
      });
    return () => {
      live = false;
    };
  }, []);

  if (error !== null) {
    return (
      <Alert tone="danger" title="Couldn’t load the server settings">
        {error}
      </Alert>
    );
  }
  if (settings === null) return <Skeleton lines={4} />;
  return <ServerSettingsList settings={settings} />;
}
