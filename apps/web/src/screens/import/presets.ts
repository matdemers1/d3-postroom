// PST-T-16.8 (PST-DA-046): provider presets for "Import mail". Client-side only — there is no network
// autodiscovery, so nothing about the address leaves the browser until the import itself starts
// (PST-REQ-175). Every preset is IMAP over implicit TLS on 993.

export interface ImportPreset {
  id: string;
  label: string;
  /** Blank for "Other". */
  host: string;
  port: string;
  /** Domains of an address that pick this preset. */
  domains: readonly string[];
  /** A line shown under the password field while this preset is chosen. */
  passwordHint?: string;
}

export const OTHER_PRESET_ID = 'other';

export const IMPORT_PRESETS: readonly ImportPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    host: 'imap.gmail.com',
    port: '993',
    domains: ['gmail.com', 'googlemail.com'],
    passwordHint: 'Gmail needs an app-specific password; your usual one won’t work.',
  },
  {
    id: 'icloud',
    label: 'iCloud',
    host: 'imap.mail.me.com',
    port: '993',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    passwordHint: 'iCloud needs an app-specific password; your Apple Account password won’t work.',
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    host: 'outlook.office365.com',
    port: '993',
    domains: ['outlook.com', 'hotmail.com', 'live.com'],
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    host: 'imap.fastmail.com',
    port: '993',
    domains: ['fastmail.com', 'fastmail.fm'],
  },
  { id: OTHER_PRESET_ID, label: 'Other', host: '', port: '993', domains: [] },
];

export function presetById(id: string): ImportPreset | undefined {
  return IMPORT_PRESETS.find((p) => p.id === id);
}

/** The preset a typed address belongs to, or undefined when it is not an address or its domain is unknown. */
export function presetForAddress(address: string): ImportPreset | undefined {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 1 || at === trimmed.length - 1) return undefined;
  const domain = trimmed.slice(at + 1).toLowerCase();
  return IMPORT_PRESETS.find((p) => p.domains.includes(domain));
}

/** The preset a server name matches, so editing the server by hand reads as "Other". */
export function presetForHost(host: string): ImportPreset {
  const h = host.trim().toLowerCase();
  return IMPORT_PRESETS.find((p) => p.host !== '' && p.host === h) ?? (presetById(OTHER_PRESET_ID) as ImportPreset);
}
