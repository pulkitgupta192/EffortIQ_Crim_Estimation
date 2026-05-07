'use strict';
// src/services/sfd/activityEstimationEngine.js
// =========================================================
// Activity Estimation Engine (SFD Mode)
// - Input: activities with activitySubtype + complexity (or subtypeHint)
// - Effort is mapped deterministically using activity matrix (DAYS)
// - Output effort is in HOURS
// - Only CORE WBS: Dev, UT, Doc, Code Review, Code Management
// =========================================================

const { resolveEffortDays } = require('./activityMatrix.js');
const { buildCoreWbs } = require('./activityWbsBuilder.js');

// Default working day length. Override via env var if needed.
// Example: set EFFORTIQ_HOURS_PER_DAY=7.5
const HOURS_PER_DAY = (() => {
  const v = Number(process.env.EFFORTIQ_HOURS_PER_DAY);
  return Number.isFinite(v) && v > 0 ? v : 8;
})();

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
}

function safeTrim(v) {
  return String(v ?? '').trim();
}

/**
 * Estimate each activity using matrix and build core WBS.
 * @param {Array} activities
 * @returns {{
 *  ok: boolean,
 *  hoursPerDay: number,
 *  totals: { totalActivities: number, estimatedActivities: number, totalEffortDays: number, totalEffortHours: number },
 *  results: Array
 * }}
 */
function estimateActivities(activities = []) {
  const input = Array.isArray(activities) ? activities : [];
  const results = [];

  let totalHours = 0;
  let totalDays = 0;

  for (const a of input) {
    const subtype = safeTrim(a?.activitySubtype || a?.subtypeHint);
    const complexity = safeTrim(a?.complexity);

    // Preserve human-friendly fields for UI
    const baseRow = {
      id: a?.id,
      title: a?.title || a?.name || '(Untitled Activity)',
      description: a?.description || '',
      reasoning: a?.reasoning || '',
      source: a?.source,
      activitySubtype: subtype || null,
      complexity: complexity || null,
    };

    if (!subtype) {
      results.push({
        ...baseRow,
        ok: false,
        error: 'Missing activitySubtype (or subtypeHint).',
        effortDays: 0,
        effortHours: 0,
        wbs: {},
      });
      continue;
    }

    if (!complexity) {
      results.push({
        ...baseRow,
        ok: false,
        error: 'Missing complexity.',
        effortDays: 0,
        effortHours: 0,
        wbs: {},
      });
      continue;
    }

    const mapped = resolveEffortDays(subtype, complexity);
    if (!mapped.ok) {
      results.push({
        ...baseRow,
        ok: false,
        error: mapped.error || 'No effort mapping found.',
        effortDays: 0,
        effortHours: 0,
        wbs: {},
      });
      continue;
    }

    const effortDays = Number(mapped.days);
    const effortHours = effortDays * HOURS_PER_DAY;

    const wbsRes = buildCoreWbs(effortHours);

    totalDays += effortDays;
    totalHours += effortHours;

    results.push({
      ...baseRow,
      ok: true,
      // Normalize subtype/complexity using the mapping output
      activitySubtype: mapped.subtype,
      complexity: mapped.complexity,
      effortDays: round1(effortDays),
      effortHours: round1(effortHours),
      wbs: wbsRes.wbs,
      wbsMeta: {
        coreEffortHours: wbsRes.coreEffortHours,
        hoursPerDay: HOURS_PER_DAY,
      },
    });
  }

  return {
    ok: true,
    hoursPerDay: HOURS_PER_DAY,
    totals: {
      totalActivities: input.length,
      estimatedActivities: results.filter((x) => x.ok).length,
      totalEffortDays: round1(totalDays),
      totalEffortHours: round1(totalHours),
    },
    results,
  };
}

module.exports = { estimateActivities };