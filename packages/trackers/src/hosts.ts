// A curated, documented list of ESP (email service provider) open-tracking hosts and paths
// (PST-T-6.2, PST-REQ-116). Each entry names the vendor whose open-tracking pixel it is, and
// whether the host by itself is enough (a dedicated tracking subdomain, never legitimate content)
// or whether the path must also look like an open-tracking endpoint (an apex domain the same
// vendor also uses for real, non-tracking assets).
//
// A host entry matches the hostname itself and any subdomain (so `list-manage.com` also matches
// `abc123.list-manage.com`, the per-account subdomain Mailchimp actually sends).

export interface TrackerHost {
  readonly host: string;
  readonly vendor: string;
  /** True: the host alone means "tracker" (a dedicated open-tracking subdomain/domain). */
  readonly hostAlone: boolean;
}

/** Known ESP/marketing-tool hosts whose open-tracking pixels this strips. */
export const TRACKER_HOSTS: readonly TrackerHost[] = [
  { host: 'list-manage.com', vendor: 'Mailchimp', hostAlone: true },
  { host: 'mcsv.net', vendor: 'Mailchimp', hostAlone: true },
  { host: 'mcusercontent.com', vendor: 'Mailchimp', hostAlone: false },
  { host: 'ct.sendgrid.net', vendor: 'SendGrid', hostAlone: true },
  { host: 'sendgrid.net', vendor: 'SendGrid', hostAlone: false },
  { host: 'hubspotemail.net', vendor: 'HubSpot', hostAlone: true },
  { host: 'hs-analytics.net', vendor: 'HubSpot', hostAlone: true },
  { host: 'hubspotlinks.com', vendor: 'HubSpot', hostAlone: true },
  { host: 'mailgun.org', vendor: 'Mailgun', hostAlone: false },
  { host: 'mg-open.net', vendor: 'Mailgun', hostAlone: true },
  { host: 'pstmrk.it', vendor: 'Postmark', hostAlone: true },
  { host: 'spgo.io', vendor: 'SparkPost', hostAlone: true },
  { host: 'mkto-ab.com', vendor: 'Marketo', hostAlone: true },
  { host: 'mktoweb.com', vendor: 'Marketo', hostAlone: false },
  { host: 'exacttarget.com', vendor: 'Salesforce Marketing Cloud', hostAlone: false },
  { host: 'exact-target.com', vendor: 'Salesforce Marketing Cloud', hostAlone: false },
  { host: 'appboycdn.com', vendor: 'Braze', hostAlone: false },
  { host: 'customeriomail.com', vendor: 'Customer.io', hostAlone: true },
  { host: 'intercom-mail.com', vendor: 'Intercom', hostAlone: true },
  { host: 'substackcdn.com', vendor: 'Substack', hostAlone: false },
  { host: 'beehiiv.com', vendor: 'Beehiiv', hostAlone: false },
  { host: 'convertkit.com', vendor: 'ConvertKit', hostAlone: false },
  { host: 'ck.page', vendor: 'ConvertKit', hostAlone: false },
];

/** Path fragments that mean "an open-tracking pixel" wherever they appear, on any host. */
const TRACKER_PATHS: readonly string[] = ['/track/open', '/o.gif', '/open.gif', '/wf/open', '/optiext/', '/trk/open', '/email/open'];

/** True when `pathname`/`search` names an open pixel by one of the generic path patterns above. */
export function pathLooksLikeTracker(pathname: string, search: string): boolean {
  const path = pathname.toLowerCase();
  if (/\/open(?:\.\w+)?(?:[/?]|$)/.test(path)) return true;
  const full = `${path}${search.toLowerCase()}`;
  return TRACKER_PATHS.some((p) => full.includes(p));
}

/** The vendor name when `hostname`/`pathname`/`search` names a known ESP open-tracking endpoint. */
export function trackerVendorFor(hostname: string, pathname: string, search: string): string | null {
  const host = hostname.toLowerCase();
  for (const entry of TRACKER_HOSTS) {
    if (host !== entry.host && !host.endsWith(`.${entry.host}`)) continue;
    if (entry.hostAlone || pathLooksLikeTracker(pathname, search)) return entry.vendor;
  }
  return null;
}
