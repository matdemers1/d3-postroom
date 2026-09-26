// Builds the plist tree for an Apple configuration profile carrying Mail, Calendar and Contacts for
// one Postroom account (PST-T-8.6, PST-REQ-139).
import { randomUUID } from 'node:crypto';
import type { PlistValue } from './plist.js';

export interface ProfileInput {
  /** The account id, used only to build stable, unique PayloadIdentifiers. */
  readonly accountId: string;
  readonly displayName: string;
  /** e.g. `alice@d3cloud.io`. */
  readonly email: string;
  readonly appPassword: string;
  readonly imapHost: string;
  readonly submissionHost: string;
  readonly davHost: string;
  /** `https://dav.d3cloud.io/dav/principals/<id>/`, from apps/dav's own path builder. */
  readonly principalUrl: string;
}

const ORG = 'd3cloud.io';

function mailPayload(input: ProfileInput): PlistValue {
  return {
    PayloadType: 'com.apple.mail.managed',
    PayloadVersion: 1,
    PayloadIdentifier: `io.d3cloud.postroom.${input.accountId}.mail`,
    PayloadUUID: randomUUID(),
    PayloadDisplayName: 'Postroom Mail',
    PayloadOrganization: ORG,
    EmailAccountDescription: 'Postroom',
    EmailAccountName: input.displayName,
    EmailAccountType: 'EmailTypeIMAP',
    EmailAddress: input.email,
    IncomingMailServerAuthentication: 'EmailAuthPassword',
    IncomingMailServerHostName: input.imapHost,
    IncomingMailServerPortNumber: 993,
    IncomingMailServerUseSSL: true,
    IncomingMailServerUsername: input.email,
    IncomingPassword: input.appPassword,
    OutgoingMailServerAuthentication: 'EmailAuthPassword',
    OutgoingMailServerHostName: input.submissionHost,
    OutgoingMailServerPortNumber: 465,
    OutgoingMailServerUseSSL: true,
    OutgoingMailServerUsername: input.email,
    OutgoingPassword: input.appPassword,
    OutgoingPasswordSameAsIncomingPassword: false,
    SMIMEEnabled: false,
  };
}

function caldavPayload(input: ProfileInput): PlistValue {
  return {
    PayloadType: 'com.apple.caldav.account',
    PayloadVersion: 1,
    PayloadIdentifier: `io.d3cloud.postroom.${input.accountId}.caldav`,
    PayloadUUID: randomUUID(),
    PayloadDisplayName: 'Postroom Calendar',
    PayloadOrganization: ORG,
    CalDAVAccountDescription: 'Postroom',
    CalDAVHostName: input.davHost,
    CalDAVPort: 443,
    CalDAVUseSSL: true,
    CalDAVUsername: input.email,
    CalDAVPassword: input.appPassword,
    CalDAVAccountPrincipalURL: input.principalUrl,
  };
}

function carddavPayload(input: ProfileInput): PlistValue {
  return {
    PayloadType: 'com.apple.carddav.account',
    PayloadVersion: 1,
    PayloadIdentifier: `io.d3cloud.postroom.${input.accountId}.carddav`,
    PayloadUUID: randomUUID(),
    PayloadDisplayName: 'Postroom Contacts',
    PayloadOrganization: ORG,
    CardDAVAccountDescription: 'Postroom',
    CardDAVHostName: input.davHost,
    CardDAVPort: 443,
    CardDAVUseSSL: true,
    CardDAVUsername: input.email,
    CardDAVPassword: input.appPassword,
    CardDAVAccountPrincipalURL: input.principalUrl,
  };
}

/** The top-level `com.apple.configuration.managed` profile: the three payloads above, one each. */
export function buildProfile(input: ProfileInput): PlistValue {
  return {
    PayloadContent: [mailPayload(input), caldavPayload(input), carddavPayload(input)],
    PayloadDisplayName: `Postroom (${input.email})`,
    PayloadDescription: 'Sets up Mail, Calendar and Contacts for your Postroom account.',
    PayloadIdentifier: `io.d3cloud.postroom.${input.accountId}`,
    PayloadOrganization: ORG,
    PayloadRemovalDisallowed: false,
    PayloadType: 'Configuration',
    PayloadUUID: randomUUID(),
    PayloadVersion: 1,
  };
}
