// Dangerous-attachment policy (PST-REQ-065): content sniffing and quarantine reasons.
export const PACKAGE = '@postroom/attachments';

export { inspectAttachment, type InspectInput, type InspectResult } from './inspect.js';
export { attachmentPolicy, type AttachmentFinding, type AttachmentPolicyOptions, type AttachmentPolicyResult, type OpenPart } from './policy.js';
export { type AttachmentKind, type Finding, type Severity } from './magic.js';
