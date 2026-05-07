'use strict';
// src/services/sfd/activityWbsBuilder.js
// =========================================================
// Activity WBS Builder (CORE ONLY)
// For SFD-based estimation, we ONLY include:
// - Development
// - Unit Testing
// - Documentation
// - Code Review
// - Code Management
//
// IMPORTANT:
// Input is TOTAL CORE effort in HOURS.
// We partition it using the same proportions used in your existing WBS builder.
// =========================================================

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
}

/**
 * Build core WBS (no E2E, no FS).
 * @param {number} coreTotalHours
 * @returns {{ wbs: Record<string, number>, coreEffortHours: number, totalDevTuHours: number }}
 */
function buildCoreWbs(coreTotalHours) {
  const base = Number(coreTotalHours ?? 0);

  const unitTesting = base * 0.2;
  const codeReview = base * 0.1;
  const documentation = base * 0.05;
  const codeManagement = base * 0.05;

  // Development is derived so that everything sums back to base
  const development = base - unitTesting - codeReview - documentation - codeManagement;

  const wbs = {
    Development: round1(development),
    'Unit Testing': round1(unitTesting),
    'Code Review': round1(codeReview),
    Documentation: round1(documentation),
    'Code Management': round1(codeManagement),
  };

  const totalDevTuHours = round1(
    wbs.Development +
      wbs['Unit Testing'] +
      wbs.Documentation +
      wbs['Code Review'] +
      wbs['Code Management']
  );

  return {
    wbs,
    coreEffortHours: round1(base),
    totalDevTuHours,
  };
}

module.exports = { buildCoreWbs };