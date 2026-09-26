// Query-string parameters that exist only to track a click, never to address the resource
// (PST-T-6.2, PST-REQ-116). Exact names, plus two prefix families (`utm_*`, `oly_*`) that vendors
// vary the suffix of.

const EXACT_TRACKING_PARAMS = new Set([
  // Mailchimp
  'mc_cid', 'mc_eid',
  // Google Ads / Analytics click ids
  'gclid', 'dclid', 'gclsrc', 'gbraid', 'wbraid', 'gad_source',
  // Microsoft Advertising
  'msclkid',
  // HubSpot
  '_hsenc', '_hsmi', 'hsCtaTracking',
  // Marketo
  'mkt_tok',
  // Meta/Facebook, Instagram
  'fbclid', 'igshid',
  // Vero
  'vero_id', 'vero_conv',
  // RB (affiliate click id)
  'rb_clickid',
  // Adobe Analytics
  's_cid',
  // Yandex
  'yclid',
  // Alibaba tracking parameter
  'spm',
  // Generic "trk"/"trkid" seen from several ESPs
  'trk', 'trkid',
  // Klaviyo
  '_kx',
  // Salesforce Marketing Cloud
  'sfmc_id', 'sfmc_activityid',
]);

const TRACKING_PARAM_PREFIXES = ['utm_', 'oly_'];

/** True when `name` is a tracking parameter this strips from a link, never part of its address. */
export function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (EXACT_TRACKING_PARAMS.has(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p));
}

/** Query parameters, on a known wrapper host, that carry the real destination to unwrap to. */
export const REDIRECT_PARAM_NAMES: readonly string[] = ['url', 'u', 'redirect', 'redirect_to', 'target', 'link'];

export interface RedirectWrapperHost {
  readonly host: string;
  readonly vendor: string;
}

/** Known click-redirect wrappers: unwrapped only because the wrapper host itself is on this list. */
export const REDIRECT_WRAPPER_HOSTS: readonly RedirectWrapperHost[] = [
  { host: 'ct.sendgrid.net', vendor: 'SendGrid' },
  { host: 'sendgrid.net', vendor: 'SendGrid' },
  { host: 'hubspotlinks.com', vendor: 'HubSpot' },
  { host: 'clicks.beehiiv.com', vendor: 'Beehiiv' },
  { host: 'link.substack.com', vendor: 'Substack' },
  { host: 'links.mkt3337.com', vendor: 'Marketo' },
  { host: 'trk.klaviyomail.com', vendor: 'Klaviyo' },
];

/** True when `hostname` is a known click-redirect wrapper: the real destination lives in a query param. */
export function isRedirectWrapperHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return REDIRECT_WRAPPER_HOSTS.some((entry) => host === entry.host || host.endsWith(`.${entry.host}`));
}
