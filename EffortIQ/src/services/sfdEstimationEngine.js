'use strict';
// src/services/sfdEstimationEngine.js
// =========================================================
// EffortIQ - SFD Estimation Engine
// - Takes a SFD .docx document (Detailed Functional Specification)
// - Uses OpenAI/Azure OpenAI to:
//    1) Split the SFD into implementable technical activities
//    2) Classify each activity (category/subtype + complexity)
//    3) Map each activity to an EXISTING CRIM matrix key (Option A)
// - Computes effort deterministically using the same matrix logic (DAYS->HOURS)
// - Generates WBS for each activity and aggregates a combined WBS
// =========================================================

const axios = require('axios');
const { buildWbs } = require('../utils/wbsBuilder.js');
const { docxService } = require('./docxService.js');

// Keep in sync with estimationEngine.js
const HOURS_PER_DAY = (() => {
  const v = Number(process.env.EFFORTIQ_HOURS_PER_DAY);
  return Number.isFinite(v) && v > 0 ? v : 8;
})();

const ALLOWED_COMPLEXITIES = new Set(['Very Simple', 'Simple', 'Medium', 'Complex', 'Very Complex']);

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

const MATRIX_KEYS = Object.keys(crimtypeEstimateMap);

function safeTrim(v) { return String(v ?? '').trim(); }
function clampText(text, maxLen) {
  const s = safeTrim(text);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}
function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
}
function normalizeComplexity(v) {
  const s = safeTrim(v);
  return ALLOWED_COMPLEXITIES.has(s) ? s : 'Medium';
}
function extractJsonObject(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}
function emitProgress(onProgress, payload) {
  try { if (typeof onProgress === 'function') onProgress(payload); } catch (_) {}
}

function buildActivitiesPrompt(docText) {
  return `
You are a Senior IFS Technical Architect (IFS Cloud / Aurena / Projection / Client / Entity, Events, Custom Fields, Reports, Interfaces, Data Migration).

TASK:
From the SFD (Detailed Functional Specification) content below, extract a list of IMPLEMENTABLE TECHNICAL ACTIVITIES.
Each activity must be a concrete sub-task a developer can implement and test.

For EACH activity, you MUST:
1) Write a short title and goal.
2) Classify it into a high-level category: Customization | Modification | Configuration | Reports | Integration | DataMigration | Other
3) Provide a subtype (examples:
   - Configuration: Event Action, Custom Field, Enumeration/LOV, Basic Data rule, Permission/Role, Workflow rule
   - Modification: Projection + Client file, Entity/Model change, Screen modification, Flow logic / validation
   - Customization: Custom Object, Custom Page, Custom Event, Lobby, BPA
   - Reports: Business Reporter, Quick Report, Crystal/Armony, Report Designer
4) Provide a short IFS technical approach (bullet list of steps), and impacted artifacts (Projection/Client/Entity, LU/Fields, Pages, Events, Reports, APIs etc.).
5) Assign complexity (Very Simple|Simple|Medium|Complex|Very Complex).
6) Map the activity to ONE existing CRIM matrix key from this list ONLY:
   ${MATRIX_KEYS.join(', ')}

STRICT OUTPUT (JSON ONLY):
Return ONLY a JSON object with this shape:
{
  "activities": [
    {
      "title": "",
      "goal": "",
      "category": "Customization|Modification|Configuration|Reports|Integration|DataMigration|Other",
      "subtype": "",
      "ifs_technical_approach": [""],
      "impacted_artifacts": [""],
      "complexity": "Very Simple|Simple|Medium|Complex|Very Complex",
      "crim_matrix_key": "${MATRIX_KEYS.join('|')}",
      "assumptions": [""],
      "risks": [""]
    }
  ]
}

RULES:
- Do NOT include generic overhead activities (e.g., code review, unit testing, documentation). EffortIQ adds overhead via WBS.
- Prefer 5-25 activities depending on the SFD size.
- If the SFD is vague, still propose sensible technical activities and capture assumptions.

SFD CONTENT:
"""
${docText}
"""
`.trim();
}

// --- Provider calls (OpenAI/Azure OpenAI) ---
async function openaiExtractActivities(docText, providerConfig = {}) {
  const apiKey = safeTrim(providerConfig.apiKey) || safeTrim(process.env.OPENAI_API_KEY);
  const model = safeTrim(providerConfig.model) || 'gpt-4o-mini';
  const baseUrl = safeTrim(providerConfig.baseUrl) || 'https://api.openai.com';
  const timeoutMs = Number(providerConfig.timeoutMs) > 0 ? Number(providerConfig.timeoutMs) : 90000;

  if (!apiKey) return { ok: false, error: 'Missing OpenAI API Key (Settings or OPENAI_API_KEY)' };

  const prompt = buildActivitiesPrompt(docText);
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;

  const payload = {
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' }, // JSON-only behavior (you already use this pattern)
    messages: [{ role: 'user', content: prompt }],
  };

  try {
    const resp = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    });

    const content = resp?.data?.choices?.[0]?.message?.content ?? '';
    let parsed = null;

    try { parsed = JSON.parse(content); }
    catch {
      const extracted = extractJsonObject(content);
      if (extracted) try { parsed = JSON.parse(extracted); } catch { parsed = null; }
    }

    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'OpenAI returned invalid JSON', detail: { raw: content } };
    }

    return { ok: true, activities: Array.isArray(parsed.activities) ? parsed.activities : [] };
  } catch (e) {
    const status = e?.response?.status;
    const msg = e?.response?.data?.error?.message || e?.message || 'OpenAI request failed';
    return { ok: false, error: msg, status, detail: e?.response?.data };
  }
}

async function azureExtractActivities(docText, providerConfig = {}) {
  const endpoint = safeTrim(providerConfig.endpoint) || safeTrim(process.env.AZURE_OPENAI_ENDPOINT);
  const apiKey = safeTrim(providerConfig.apiKey) || safeTrim(process.env.AZURE_OPENAI_KEY);
  const deployment = safeTrim(providerConfig.deployment) || safeTrim(process.env.AZURE_OPENAI_DEPLOYMENT);
  const apiVersion = safeTrim(providerConfig.apiVersion) || safeTrim(process.env.AZURE_OPENAI_API_VERSION) || '2024-06-01';
  const timeoutMs = Number(providerConfig.timeoutMs) > 0 ? Number(providerConfig.timeoutMs) : 90000;

  if (!endpoint || !apiKey || !deployment) {
    return { ok: false, error: 'Missing Azure OpenAI configuration (endpoint/apiKey/deployment).' };
  }

  const base = endpoint.replace(/^['"]|['"]$/g, '').replace(/\/+$/, '');
  const url = `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  const prompt = buildActivitiesPrompt(docText);

  const payload = {
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  };

  try {
    const resp = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      timeout: timeoutMs,
    });

    const content = resp?.data?.choices?.[0]?.message?.content ?? '';
    let parsed = null;

    try { parsed = JSON.parse(content); }
    catch {
      const extracted = extractJsonObject(content);
      if (extracted) try { parsed = JSON.parse(extracted); } catch { parsed = null; }
    }

    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'Azure OpenAI returned invalid JSON', detail: { raw: content } };
    }

    return { ok: true, activities: Array.isArray(parsed.activities) ? parsed.activities : [] };
  } catch (e) {
    const status = e?.response?.status;
    const msg = e?.response?.data?.error?.message || e?.response?.data?.message || e?.message || 'Azure OpenAI request failed';
    return { ok: false, error: msg, status, detail: e?.response?.data };
  }
}

function resolveBaseDays(matrixKey, complexity) {
  const key = safeTrim(matrixKey);
  const map = crimtypeEstimateMap[key];
  if (!map) return { ok: false, baseDays: 0, error: `Unknown matrix key: ${key}` };
  const days = map[complexity];
  if (days == null) return { ok: false, baseDays: 0, error: `No effort for ${key} / ${complexity}` };
  return { ok: true, baseDays: Number(days) };
}

function aggregateWbs(rows) {
  const out = {};
  for (const r of rows) {
    if (!r || !r.ok || !r.wbs) continue;
    for (const [k, v] of Object.entries(r.wbs)) {
      const n = Number(v || 0);
      if (!Number.isFinite(n) || n <= 0) continue;
      out[k] = round1((out[k] || 0) + n);
    }
  }
  return out;
}

const sfdEstimationEngine = {
  /**
   * Process an SFD file path and return per-activity estimates + aggregated totals.
   * @param {string} filePath
   * @param {{provider?:'openai'|'azure', config?:any}} options
   * @param {(progress:any)=>void} onProgress
   */
  async processSfdFile(filePath, options = {}, onProgress = null) {
    const provider = String(options.provider || 'openai').toLowerCase();
    const providerConfig = options.config || {};

    emitProgress(onProgress, { stage: 'start', percent: 0, message: 'Reading SFD document...' });

    const parsed = await docxService.extractRawText(filePath);
    if (!parsed.ok) return { ok: false, error: parsed.error || 'Failed to parse SFD document' };

    const docText = clampText(parsed.text, 24000);

    emitProgress(onProgress, { stage: 'ai_start', percent: 15, message: 'AI is extracting activities from SFD...' });

    let ai;
    if (provider === 'azure') ai = await azureExtractActivities(docText, providerConfig);
    else if (provider === 'openai') ai = await openaiExtractActivities(docText, providerConfig);
    else ai = { ok: false, error: `SFD estimation supports only OpenAI/Azure providers. Selected: ${provider}` };

    if (!ai.ok) return { ok: false, error: ai.error || 'AI activity extraction failed', status: ai.status, detail: ai.detail };

    const rawActivities = Array.isArray(ai.activities) ? ai.activities : [];
    emitProgress(onProgress, { stage: 'ai_done', percent: 45, message: `AI extracted ${rawActivities.length} activities` });

    const results = [];
    for (let i = 0; i < rawActivities.length; i += 1) {
      const a = rawActivities[i] || {};
      const idx = i + 1;

      emitProgress(onProgress, {
        stage: 'compute',
        percent: 45 + Math.round((idx * 50) / Math.max(1, rawActivities.length)),
        message: `Computing effort for activity ${idx}/${rawActivities.length}`,
        index: idx,
        total: rawActivities.length,
      });

      const title = safeTrim(a.title) || `Activity ${idx}`;
      const goal = safeTrim(a.goal);
      const category = safeTrim(a.category) || 'Other';
      const subtype = safeTrim(a.subtype);
      const complexity = normalizeComplexity(a.complexity);
      const matrixKey = safeTrim(a.crim_matrix_key);

      const base = resolveBaseDays(matrixKey, complexity);
      if (!base.ok) {
        results.push({ ok: false, kind: 'sfd_activity', summary: title, title, category, subtype, matrix_key: matrixKey, complexity, error: base.error, reasoning: `Matrix mapping failed: ${base.error}` });
        continue;
      }

      const baseEffortDays = round1(base.baseDays);
      const baseEffortHours = round1(baseEffortDays * HOURS_PER_DAY);

      const { wbs, finalEffort } = buildWbs(baseEffortHours, complexity);
      const finalEffortHours = round1(finalEffort);

      const approach = Array.isArray(a.ifs_technical_approach) ? a.ifs_technical_approach : [];
      const artifacts = Array.isArray(a.impacted_artifacts) ? a.impacted_artifacts : [];
      const assumptions = Array.isArray(a.assumptions) ? a.assumptions : [];
      const risks = Array.isArray(a.risks) ? a.risks : [];

      const reasoning = [
        goal ? `Goal: ${goal}` : null,
        subtype ? `Subtype: ${subtype}` : null,
        artifacts.length ? `Impacted: ${artifacts.join(', ')}` : null,
        approach.length ? `Approach:\n- ${approach.map(x => safeTrim(x)).filter(Boolean).join('\n- ')}` : null,
        assumptions.length ? `Assumptions:\n- ${assumptions.map(x => safeTrim(x)).filter(Boolean).join('\n- ')}` : null,
        risks.length ? `Risks:\n- ${risks.map(x => safeTrim(x)).filter(Boolean).join('\n- ')}` : null,
      ].filter(Boolean).join('\n\n');

      results.push({
        ok: true,
        kind: 'sfd_activity',
        summary: title,
        title,
        description: goal,
        crim_type: category,
        category,
        subtype,
        sub_type: matrixKey,
        matrix_key: matrixKey,
        complexity,
        reasoning,
        baseEffortDays,
        baseEffortHours,
        baseEffort: baseEffortHours,
        finalEffortHours,
        finalEffort: finalEffortHours,
        hours: finalEffortHours,
        wbs,
      });
    }

    const okRows = results.filter(r => r && r.ok);
    const totalFinalHours = round1(okRows.reduce((a, r) => a + Number(r.finalEffortHours || r.finalEffort || 0), 0));
    const totalBaseHours = round1(okRows.reduce((a, r) => a + Number(r.baseEffortHours || r.baseEffort || 0), 0));
    const totalWbs = aggregateWbs(okRows);

    const summaryRow = {
      ok: true,
      kind: 'sfd_total',
      summary: 'TOTAL (All Activities)',
      title: 'TOTAL (All Activities)',
      crim_type: 'SFD',
      category: 'SFD',
      subtype: 'TOTAL',
      sub_type: '',
      matrix_key: '',
      complexity: 'N/A',
      reasoning: `Aggregated from ${okRows.length} activities extracted from SFD.`,
      baseEffort: totalBaseHours,
      finalEffort: totalFinalHours,
      hours: totalFinalHours,
      wbs: totalWbs,
    };

    emitProgress(onProgress, { stage: 'done', percent: 100, message: 'SFD estimation completed' });

    return {
      ok: true,
      data: {
        stats: parsed.stats,
        totalActivities: results.length,
        successfulActivities: okRows.length,
        totalBaseHours,
        totalFinalHours,
        totalWbs,
        rows: [summaryRow, ...results],
      },
    };
  },
};

module.exports = { sfdEstimationEngine };