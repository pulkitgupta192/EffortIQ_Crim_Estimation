'use strict';

// src/utils/wbsBuilder.js
// =========================================================
// EffortIQ WBS Builder (Production-ready)
// Ported from Forge project's wbs-builder.js
//
// BaseTotalEffort represents:
//   Development + Unit Testing ONLY
//
// FinalEffort represents:
//   BaseTotalEffort + End-to-End Testing + Functional Specification
// =========================================================

const E2E_TEST_PERCENTAGE = {
  None: 0,
  'Very Simple': 0.1,
  Simple: 0.2,
  Medium: 0.3,
  Complex: 0.4,
  'Very Complex': 0.5,
};

const SFD_PERCENTAGE = {
  None: 0,
  'Very Simple': 0.1,
  Simple: 0.2,
  Medium: 0.3,
  Complex: 0.4,
  'Very Complex': 0.5,
};

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
}

/**
 * Build WBS based on deterministic effort rules.
 * @param {number} baseTotalEffort - Dev + Unit Testing only
 * @param {string} complexity - Very Simple | Simple | Medium | Complex | Very Complex
 * @returns {{ wbs: Record<string, number>, finalEffort: number }}
 */
function buildWbs(baseTotalEffort, complexity) {
  const base = Number(baseTotalEffort || 0);

  // Overheads (based on Base Total Effort)
  const unitTesting = base * 0.2;
  const codeReview = base * 0.1;
  const documentation = base * 0.05;
  const codeManagement = base * 0.05;

  // Development is derived
  const development = base - unitTesting - codeReview - documentation - codeManagement;

  // End-to-End Testing (based on DEV only)
  const e2ePercentage = E2E_TEST_PERCENTAGE[complexity] ?? 0;
  const endToEndTesting = development * e2ePercentage;

  // Functional Specification (based on DEV only)
  const sfdPercentage = SFD_PERCENTAGE[complexity] ?? 0;
  const functionalSpecification = development * sfdPercentage;

  // Final effort
  const finalEffort = base + endToEndTesting + functionalSpecification;

  return {
    wbs: {
      Development: round1(development),
      'Unit Testing': round1(unitTesting),
      'Code Review': round1(codeReview),
      Documentation: round1(documentation),
      'Code Management': round1(codeManagement),
      'End-to-End Testing': round1(endToEndTesting),
      'Functional Specification': round1(functionalSpecification),
    },
    finalEffort: round1(finalEffort),
  };
}

module.exports = { buildWbs };
