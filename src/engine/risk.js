/**
 * Re-export — risk completo vive em src/risk/ (P4).
 * Mantém createBasicRisk para callers P1.
 */

export { createBasicRisk, createRiskEngine } from '../risk/createRiskEngine.js';
export { RISK_REASON } from '../risk/reasons.js';
