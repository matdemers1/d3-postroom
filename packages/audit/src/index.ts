// Audit trail: every mutation records actor, action, entity and before/after (PST-REQ-009).
export const PACKAGE = '@postroom/audit';

export { redact } from './redact.js';
export type { Actor, RequestContext } from './types.js';
export { recordAudit } from './record.js';
export type { AuditInput, AuditTx } from './record.js';
export { audited } from './audited.js';
export type { AuditedSpec, AuditedWrite } from './audited.js';
export { auditContext, mutationAuditGuard, getAuditContext, missingAuditCount, waitForAuditGuard } from './express.js';
export { listAudit } from './list.js';
export type { ListAuditOptions, ListAuditPage } from './list.js';
