'use strict';
// src/services/sfd/activityAiClassifier.js
// =========================================================
// AI Activity Classification
// - Input: activities extracted from SFD
// - Output: for each activity => subtype + complexity + reasoning
// - Effort is NOT computed by AI (deterministic matrix later).
// =========================================================

const { runJsonPrompt } = require('./llmClient.js');
const {
  ALLOWED_SUBTYPES,
  ALLOWED_COMPLEXITIES,
  normalizeSubtype,
  normalizeComplexity,
} = require('./activityMatrix.js');

function safeTrim(v) {
  return String(v ?? '').trim();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildPrompt(batch, options = {}) {
  const includeSourceHints = Boolean(options.includeSourceHints);

  const subtypeList = Array.from(ALLOWED_SUBTYPES).sort().join(', ');
  const complexityList = Array.from(ALLOWED_COMPLEXITIES).join(', ');

  const items = batch.map(a => ({
    id: a.id,
    title: a.title,
    description: a.description,
    subtypeHint: a.subtypeHint ?? null,
  }));

  return `
You are a Senior IFS Technical Architect.
Your job is to classify IMPLEMENTATION ACTIVITIES extracted from a Functional Specification Document (SFD).

RULES (VERY IMPORTANT):
- DO NOT estimate effort in hours/days.
- ONLY classify each activity with:
  - activitySubtype: one of [${subtypeList}]
  - complexity: one of [${complexityList}]
  - reasoning: short, technical, IFS-focused explanation.
- If subtypeHint is provided, you may accept it if correct; otherwise choose the best subtype.
- Prefer IFS Cloud best practices. Use IFS concepts like Aurena screens, projections, LU APIs, Voucher_Row_API, events, interfaces, reports, migrations.
${includeSourceHints ? "- If likely impacted APIs/components exist, mention them in reasoning." : ""}

Return STRICT JSON ONLY with this structure:
{
  "items": [
    {
      "id": "ACT-...",
      "activitySubtype": "CU_PA",
      "complexity": "Medium",
      "reasoning": "..."
    }
  ]
}

INPUT ACTIVITIES:
${JSON.stringify({ items }, null, 2)}
`.trim();
}

function normalizeItem(x) {
  const id = safeTrim(x?.id);
  const activitySubtype = normalizeSubtype(x?.activitySubtype) ?? null;
  const complexity = normalizeComplexity(x?.complexity) ?? null;
  const reasoning = safeTrim(x?.reasoning);
  return { id, activitySubtype, complexity, reasoning };
}

/**
 * Classify activities in batches.
 * @param {Array} activities
 * @param {'openai'|'azure'|'gemini'|'local'} provider
 * @param {object} providerConfig
 * @param {object} options
 */
async function classifyActivities(activities, provider, providerConfig, options = {}) {
  const input = Array.isArray(activities) ? activities : [];
  if (!input.length) return { ok: true, activities: [], errors: [] };

  const batchSize = Number(options.batchSize) > 0 ? Number(options.batchSize) : 10;
  const batches = chunk(input, batchSize);

  const out = [];
  const errors = [];

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const prompt = buildPrompt(batch, options);

    const res = await runJsonPrompt(provider, prompt, providerConfig);

    if (!res?.ok) {
      errors.push({
        batch: i + 1,
        error: res?.error ?? 'LLM failed',
        status: res?.status,
        detail: res?.detail,
      });
      continue;
    }

    const items = Array.isArray(res.data?.items) ? res.data.items : [];
    for (const it of items) {
      const norm = normalizeItem(it);
      if (norm.id) out.push(norm);
    }
  }

  // Map classifications back by id
  const map = new Map(out.map(x => [x.id, x]));

  const merged = input.map(a => {
    const c = map.get(a.id) || {};
    return {
      ...a,
      activitySubtype: c.activitySubtype ?? a.subtypeHint ?? null,
      complexity: c.complexity ?? null,
      reasoning: c.reasoning ?? '',
      source: { ...(a.source || {}), classifiedBy: 'ai' },
    };
  });

  return { ok: errors.length === 0, activities: merged, errors };
}

module.exports = { classifyActivities };