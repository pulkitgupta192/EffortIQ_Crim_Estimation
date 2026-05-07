'use strict';
// src/services/sfd/activityMatrix.js
// =========================================================
// Activity Effort Matrix (DAYS)
// - This is intentionally aligned with the existing CRIM matrix.
// - Values are in DAYS.
// - Conversion to HOURS happens in activityEstimationEngine.
// =========================================================

const ALLOWED_COMPLEXITIES = new Set(['Very Simple', 'Simple', 'Medium', 'Complex', 'Very Complex']);

// Subtypes used across EffortIQ mapping.
// Keep this list in sync with your CRIM mapping governance.
const ALLOWED_SUBTYPES = new Set([
  'CU_OB','CU_PA','CU_EV','CU_BP','CU_LO',
  'RE_BR','RE_QR',
  'IN_IN','IN_OU','IN_AP','IN_AD',
  'MO_FL','MO_SC',
  'FO_AR','FO_CR','FO_RD',
  'DM_MT','DM_SC'
]);

// NOTE: DAYS matrix
const activityEffortMatrixDays = {
  CU_OB: { 'Very Simple': 0.25, Simple: 0.5, Medium: 1, Complex: 2, 'Very Complex': 4 },
  CU_PA: { 'Very Simple': 1, Simple: 2, Medium: 4, Complex: 8, 'Very Complex': 16 },
  CU_EV: { 'Very Simple': 1, Simple: 2, Medium: 4, Complex: 7, 'Very Complex': 14 },
  CU_BP: { 'Very Simple': 1, Simple: 2, Medium: 4, Complex: 9, 'Very Complex': 18 },
  CU_LO: { 'Very Simple': 0.75, Simple: 1.5, Medium: 3, Complex: 6, 'Very Complex': 9 },
  RE_BR: { 'Very Simple': 1, Simple: 2, Medium: 6, Complex: 10, 'Very Complex': 15 },
  RE_QR: { 'Very Simple': 0.5, Simple: 1, Medium: 2, Complex: 4, 'Very Complex': 6 },
  IN_IN: { 'Very Simple': 4, Simple: 8, Medium: 14, Complex: 21, 'Very Complex': 30 },
  IN_OU: { 'Very Simple': 3, Simple: 6, Medium: 10, Complex: 15, 'Very Complex': 22 },
  IN_AP: { 'Very Simple': 3, Simple: 6, Medium: 10, Complex: 15, 'Very Complex': 22 },
  IN_AD: { 'Very Simple': 1.5, Simple: 3, Medium: 6, Complex: 10, 'Very Complex': 15 },
  MO_FL: { 'Very Simple': 3, Simple: 6, Medium: 12, Complex: 18, 'Very Complex': 24 },
  MO_SC: { 'Very Simple': 1, Simple: 2, Medium: 4, Complex: 8, 'Very Complex': 16 },
  FO_RD: { 'Very Simple': 1.5, Simple: 3, Medium: 6, Complex: 12, 'Very Complex': 18 },
  FO_AR: { 'Very Simple': 0.75, Simple: 1.5, Medium: 3, Complex: 6, 'Very Complex': 9 },
  FO_CR: { 'Very Simple': 1.25, Simple: 2.25, Medium: 4.5, Complex: 9, 'Very Complex': 13.5 },
  DM_MT: { 'Very Simple': 0.5, Simple: 1.5, Medium: 3, Complex: 7, 'Very Complex': 12 },
  DM_SC: { 'Very Simple': 1, Simple: 3, Medium: 6, Complex: 9, 'Very Complex': 12 },
};

function safeTrim(v) {
  return String(v ?? '').trim();
}

function normalizeComplexity(v) {
  const s = safeTrim(v);
  return ALLOWED_COMPLEXITIES.has(s) ? s : null;
}

function normalizeSubtype(v) {
  const s = safeTrim(v).toUpperCase();
  return ALLOWED_SUBTYPES.has(s) ? s : null;
}

function resolveEffortDays(subtype, complexity) {
  const st = normalizeSubtype(subtype);
  const cx = normalizeComplexity(complexity);
  if (!st) return { ok: false, error: `Unknown activity subtype: ${subtype}` };
  if (!cx) return { ok: false, error: `Unknown complexity: ${complexity}` };

  const map = activityEffortMatrixDays[st];
  const days = map ? map[cx] : null;
  if (days == null) return { ok: false, error: `No effort mapping for ${st} / ${cx}` };
  return { ok: true, days: Number(days), subtype: st, complexity: cx };
}

module.exports = {
  ALLOWED_COMPLEXITIES,
  ALLOWED_SUBTYPES,
  activityEffortMatrixDays,
  normalizeComplexity,
  normalizeSubtype,
  resolveEffortDays,
};
