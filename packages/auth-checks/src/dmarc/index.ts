export {
  applyDmarcPolicy,
  authResultsDmarc,
  domainsAligned,
  evaluateDmarc,
  fromDomainsOf,
  type AlignmentMode,
  type DmarcAlignment,
  type DmarcDisposition,
  type DmarcDkimInput,
  type DmarcIdentifiers,
  type DmarcResult,
  type DmarcResultCode,
  type DmarcSpfInput,
  type EvaluateDmarcInput,
} from './evaluate.js';
export { fetchDmarcPolicy, type DmarcDns, type DmarcPolicyLookup } from './policy.js';
export {
  parseDmarcRecord,
  type DmarcAlignmentMode,
  type DmarcPolicy,
  type DmarcRecord,
  type DmarcRecordParse,
} from './record.js';
