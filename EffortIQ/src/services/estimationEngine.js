'use strict';
// src/services/estimationEngine.js
// =========================================================
// EffortIQ Estimation Engine
// - Processes Excel rows
// - Calls selected provider to classify complexity + reasoning
// - Computes Base Effort deterministically using CRIM mapping rules
//
// IMPORTANT UNIT FIX:
// - The CRIM x Complexity matrix values are defined in DAYS.
// - Internally, downstream calculations (WBS, totals, Jira seconds) operate in HOURS.
// - Therefore: baseDays (from matrix) -> baseHours (baseDays * HOURS_PER_DAY) happens ONCE here.
//
// Output contract (backward compatible):
// - finalEffort / hours remain HOURS (as used by UI + Jira integration)
// - baseEffort remains HOURS (legacy)
// - baseEffortDays / finalEffortDays added for traceability
// =========================================================

const { buildWbs } = require('../utils/wbsBuilder.js');
const { openaiEstimate } = require('../providers/openaiProvider.js');
const { azureEstimate } = require('../providers/azureProvider.js');
const { geminiEstimate } = require('../providers/geminiProvider.js');
const { localEstimate } = require('../providers/localProvider.js');

// Default working day length. Override via env var if needed.
// Example: set EFFORTIQ_HOURS_PER_DAY=7.5
const HOURS_PER_DAY = (() => {
  const v = Number(process.env.EFFORTIQ_HOURS_PER_DAY);
  return Number.isFinite(v) && v > 0 ? v : 8;
})();

const typeToSubtype = {
  'Custom Objects': 'CU_OB',
  'Custom Page/Screen/Tab': 'CU_PA',
  'Custom Event': 'CU_EV',
  'BPA': 'CU_BP',
  'Lobby': 'CU_LO',
  'Business Report': 'RE_BR',
  'Quick Report': 'RE_QR',
  'Interface (IN)': 'IN_IN',
  'Interface (OUT)': 'IN_OU',
  'Interface (API)': 'IN_AP',
  'Interface Armony Data': 'IN_AD',
  'Modification Flux': 'MO_FL',
  'Modification Screen': 'MO_SC',
  'Forms Armony Report': 'FO_AR',
  'Forms Crystal Report': 'FO_CR',
  'Forms Report Designer': 'FO_RD',
  'Data Migration (Migration Task)': 'DM_MT',
  'Data Migration (Script)': 'DM_SC',
};

// NOTE: Values in this matrix are DAYS (not hours).
const crimtypeEstimateMap = {
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

const ALLOWED_COMPLEXITIES = new Set(['Very Simple', 'Simple', 'Medium', 'Complex', 'Very Complex']);

function safeTrim(v) {
  return String(v ?? '').trim();
}

function normalizeComplexity(v) {
  const s = safeTrim(v);
  return ALLOWED_COMPLEXITIES.has(s) ? s : 'Medium';
}

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
}

function normalizeProviderResponse(res) {
  if (!res) return { ok: false, error: 'Empty AI provider response' };
  if (res.ok && res.meta && typeof res.meta === 'object') return res;

  if (res.ok) {
    const complexity = res.complexity ?? res.meta?.complexity;
    const reason = res.reason ?? res.reasoning ?? res.meta?.reason ?? res.meta?.reasoning ?? '';
    return {
      ok: true,
      meta: {
        complexity,
        direction: res.direction ?? res.meta?.direction ?? 'N/A',
        flow: res.flow ?? res.meta?.flow ?? 'N/A',
        reason,
      },
    };
  }

  return {
    ok: false,
    error: res.error ?? res.message ?? 'AI provider failed',
    status: res.status,
    detail: res.detail,
  };
}

function getProviderFn(provider) {
  switch (String(provider ?? 'openai').toLowerCase()) {
    case 'azure':
      return azureEstimate;
    case 'gemini':
      return geminiEstimate;
    case 'local':
      return localEstimate;
    case 'openai':
    default:
      return openaiEstimate;
  }
}

// Returns base effort in DAYS from matrix
function resolveBaseEffortDays(crim_type, complexity) {
  const subtype = typeToSubtype[crim_type] ?? null;
  if (!subtype) {
    return { ok: false, subtype: null, baseDays: 0, error: `Unknown CRIM Type: ${crim_type}` };
  }

  const map = crimtypeEstimateMap[subtype];
  if (!map) {
    return { ok: false, subtype, baseDays: 0, error: `No estimate map for subtype: ${subtype}` };
  }

  const base = map[complexity];
  if (base == null) {
    return { ok: false, subtype, baseDays: 0, error: `No base effort for ${subtype} / ${complexity}` };
  }

  return { ok: true, subtype, baseDays: Number(base) };
}

function emitProgress(onProgress, payload) {
  try {
    if (typeof onProgress === 'function') onProgress(payload);
  } catch (_) {
    // ignore
  }
}

const estimationEngine = {
  async processRows(rows, options = {}, onProgress = null) {
    const provider = options.provider ?? 'openai';
    const providerConfig = options.config ?? {};
    const providerFn = getProviderFn(provider);

    const inputRows = Array.isArray(rows) ? rows : [];
    const total = inputRows.length;
    const results = [];

    emitProgress(onProgress, {
      stage: 'start',
      index: 0,
      total,
      percent: total ? 0 : 100,
      message: `Starting ${total} rows...`,
    });

    for (let i = 0; i < inputRows.length; i += 1) {
      const idx = i + 1;
      const row = inputRows[i] ?? {};

      const summary = safeTrim(row.summary);
      const description = safeTrim(row.description);
      const crim_type = safeTrim(row.crim_type) || 'Unknown';

      emitProgress(onProgress, {
        stage: 'row_start',
        index: idx,
        total,
        percent: total ? Math.round(((idx - 1) * 100) / total) : 100,
        message: `Analyzing row ${idx}/${total} (AI running)`,
      });

      if (!summary && !description) {
        results.push({ ok: false, summary, description, crim_type, error: 'Empty summary/description' });
        emitProgress(onProgress, {
          stage: 'row_done',
          index: idx,
          total,
          percent: total ? Math.round((idx * 100) / total) : 100,
          message: `Skipped empty row ${idx}/${total}`,
        });
        continue;
      }

      try {
        const aiRaw = await providerFn(
          summary,
          description,
          providerConfig.model ?? null,
          { crim_type },
          providerConfig
        );

        const ai = normalizeProviderResponse(aiRaw);
        if (!ai.ok) {
          results.push({
            ok: false,
            summary,
            description,
            crim_type,
            error: ai.error ?? 'AI classification failed',
            status: ai.status,
            detail: ai.detail,
          });

          emitProgress(onProgress, {
            stage: 'row_done',
            index: idx,
            total,
            percent: total ? Math.round((idx * 100) / total) : 100,
            message: `AI failed for row ${idx}/${total}`,
          });
          continue;
        }

        emitProgress(onProgress, {
          stage: 'ai_done',
          index: idx,
          total,
          percent: total ? Math.round(((idx - 0.5) * 100) / total) : 100,
          message: `AI estimated row ${idx}/${total}`,
        });

        const complexity = normalizeComplexity(ai.meta.complexity);
        const reasoning = safeTrim(ai.meta.reason);

        // ✅ Matrix returns DAYS
        const baseRes = resolveBaseEffortDays(crim_type, complexity);
        if (!baseRes.ok) {
          results.push({
            ok: false,
            summary,
            description,
            crim_type,
            complexity,
            reasoning,
            error: baseRes.error,
          });

          emitProgress(onProgress, {
            stage: 'row_done',
            index: idx,
            total,
            percent: total ? Math.round((idx * 100) / total) : 100,
            message: `Mapping failed row ${idx}/${total}`,
          });
          continue;
        }

        // ✅ Convert once: DAYS -> HOURS
        const baseEffortDays = round1(baseRes.baseDays);
        const baseEffortHours = round1(baseEffortDays * HOURS_PER_DAY);

        // buildWbs expects baseTotalEffort in HOURS
        const { wbs, finalEffort } = buildWbs(baseEffortHours, complexity);

        const finalEffortHours = round1(finalEffort);
        const finalEffortDays = round1(finalEffortHours / HOURS_PER_DAY);

        results.push({
          ok: true,
          summary,
          description,
          crim_type,
          sub_type: baseRes.subtype,
          complexity,
          reasoning,
          direction: safeTrim(ai.meta.direction) || 'N/A',
          flow: safeTrim(ai.meta.flow) || 'N/A',

          // Traceability
          baseEffortDays,
          baseEffortHours,
          finalEffortHours,
          finalEffortDays,

          // Backward-compatible fields (HOURS)
          baseEffort: baseEffortHours,
          finalEffort: finalEffortHours,
          hours: finalEffortHours,

          wbs,
        });

        emitProgress(onProgress, {
          stage: 'row_done',
          index: idx,
          total,
          percent: total ? Math.round((idx * 100) / total) : 100,
          message: `Completed row ${idx}/${total}`,
        });
      } catch (e) {
        results.push({
          ok: false,
          summary,
          description,
          crim_type,
          error: e?.message || 'Processing failed',
        });

        emitProgress(onProgress, {
          stage: 'row_done',
          index: idx,
          total,
          percent: total ? Math.round((idx * 100) / total) : 100,
          message: `Error on row ${idx}/${total}`,
        });
      }
    }

    emitProgress(onProgress, {
      stage: 'done',
      index: total,
      total,
      percent: 100,
      message: `Estimation completed (${total} rows)`,
    });

    return results;
  },
};

module.exports = { estimationEngine };
