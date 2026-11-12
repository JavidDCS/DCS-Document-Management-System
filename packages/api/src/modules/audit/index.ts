export { recordAudit, type Db, type AuditRecord } from './audit.service.js';
export { verifyAuditChain, type VerifyResult, type VerifyFailureReason } from './audit.verify.js';
export { computeEntryHash, canonicalJson } from './audit.hash.js';
export { auditContext } from './audit.context.js';
