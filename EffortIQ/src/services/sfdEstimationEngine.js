'use strict';
// src/services/sfdEstimationEngine.js
// =========================================================
// EffortIQ - SFD Estimation Engine
// - Extract activities from SFD DOCX using AI (OpenAI/Azure)
// - For each activity: map CRIM Type + Complexity -> Dev effort (matrix DAYS->HOURS)
// - Compute Dev Support Activities on TOTAL DEV
// - Final Effort = Dev + Dev Support (✅ NO Functional Spec, ✅ NO E2E)
// - Generate ONE overall AI reasoning for the whole CRIM
// =========================================================
const axios = require('axios');
const { docxService } = require('./docxService.js');

// Keep in sync with estimationEngine.js default day length
const HOURS_PER_DAY = (() => {
  const v = Number(process.env.EFFORTIQ_HOURS_PER_DAY);
  return Number.isFinite(v) && v > 0 ? v : 8;
})();

const ALLOWED_COMPLEXITIES = new Set(['Very Simple', 'Simple', 'Medium', 'Complex', 'Very Complex']);

// --- Same CRIM Type -> Subtype mapping as XLSX estimationEngine.js ---
const typeToSubtype = {
  'Custom Objects': 'CU_OB',
  'Custom Page/Screen/Tab': 'CU_PA',
  'Custom Event': 'CU_EV',
  BPA: 'CU_BP',
  Lobby: 'CU_LO',
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
const CRIM_TYPES = Object.keys(typeToSubtype);

// NOTE: values are DAYS (same as XLSX)
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
function normalizeCrimType(v) {
  const raw = safeTrim(v);
  if (!raw) return 'Custom Objects';
  if (typeToSubtype[raw]) return raw;
  const lower = raw.toLowerCase();
  const match = CRIM_TYPES.find((t) => t.toLowerCase() === lower);
  return match || 'Custom Objects';
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

// Complexity ordering for overall (SFD final) complexity
const COMPLEXITY_ORDER = { 'Very Simple': 1, Simple: 2, Medium: 3, Complex: 4, 'Very Complex': 5 };
function maxComplexity(list) {
  let best = 'Medium';
  let bestRank = 3;
  for (const c of list) {
    const rank = COMPLEXITY_ORDER[c] || 0;
    if (rank > bestRank) { bestRank = rank; best = c; }
  }
  return best;
}

function resolveDevDaysFromMatrix(crimType, complexity) {
  const type = normalizeCrimType(crimType);
  const subtype = typeToSubtype[type];
  if (!subtype) return { ok: false, type, subtype: null, days: 0, error: `Unknown CRIM Type: ${type}` };
  const map = crimtypeEstimateMap[subtype];
  if (!map) return { ok: false, type, subtype, days: 0, error: `No estimate map for subtype: ${subtype}` };
  const days = map[complexity];
  if (days == null) return { ok: false, type, subtype, days: 0, error: `No effort for ${subtype} / ${complexity}` };
  return { ok: true, type, subtype, days: Number(days) };
}

// ✅ Build WBS from total DEV (NO E2E, NO Functional Spec)
// Support percentages stay same as before: UT 20%, CR 10%, Doc 5%, CM 5%
// (applied on DEV total)
function buildWbsFromTotalDev(devTotalHours) {
  const dev = Number(devTotalHours || 0);

  const unitTesting = dev * 0.2;
  const codeReview = dev * 0.1;
  const documentation = dev * 0.05;
  const codeManagement = dev * 0.05;

  const totalDevSupport = unitTesting + codeReview + documentation + codeManagement;
  const totalEffort = dev + totalDevSupport;

  const wbs = {
    Development: round1(dev),
    'Unit Testing': round1(unitTesting),
    'Code Review': round1(codeReview),
    Documentation: round1(documentation),
    'Code Management': round1(codeManagement),
  };

  return {
    wbs,
    totals: {
      totalDevHours: round1(dev),
      totalDevSupportHours: round1(totalDevSupport),
      totalEffortHours: round1(totalEffort),
      totalEffortDays: round1(totalEffort / HOURS_PER_DAY),
      hoursPerDay: HOURS_PER_DAY,
    },
  };
}

// -----------------------
// AI prompts
// -----------------------
function buildSfdPrompt(docText) {
  return `
You are a Senior IFS Technical Architect (IFS Cloud / Aurena / Custom Objects, Events, Reports, Integrations, Data Migration).

TASK:
From the SFD content below, extract IMPLEMENTABLE TECHNICAL ACTIVITIES.

TOP-LEVEL CLASSIFICATION:
- direction: Inbound / Outbound / Bi-Directional / N/A
- flow: Uni-Directional / Bi-Directional / N/A

FOR EACH ACTIVITY YOU MUST:
1) Provide a short title and goal.
2) Assign CRIM Type ONLY from this allowed list (must match exactly):
${CRIM_TYPES.map((t) => `- ${t}`).join('\n')}
3) Assign complexity ONLY from: Very Simple, Simple, Medium, Complex, Very Complex
4) Provide AI reasoning (short, professional) justifying CRIM Type + complexity

STRICT OUTPUT (JSON ONLY):
Return ONLY a JSON object with this shape:
{
  "direction": "Inbound/Outbound/Bi-Directional/N/A",
  "flow": "Uni-Directional/Bi-Directional/N/A",
  "activities": [
    {
      "title": "",
      "goal": "",
      "crim_type": "",
      "complexity": "Very Simple/Simple/Medium/Complex/Very Complex",
      "ai_reasoning": ""
    }
  ]
}

RULES:
- Do NOT include generic overhead activities (code review, unit testing, documentation, code management).
- Prefer 5-25 activities depending on SFD size.

SFD CONTENT:
"""
${docText}
"""
`.trim();
}

function buildOverallReasoningPrompt({ direction, flow, overallComplexity, activitiesBrief }) {
  const brief = activitiesBrief.slice(0, 25).map((a, i) =>
    `${i + 1}. ${a.title} | ${a.crim_type} | ${a.complexity} | ${a.goal || ''}`.trim()
  ).join('\n');

  return `
You are a Senior IFS Technical Architect.

TASK:
Write ONE overall AI reasoning for the full CRIM/SFD, summarizing why the overall complexity is "${overallComplexity}"
and how the listed activities cover the implementation scope.

CONTEXT:
Direction: ${direction}
Flow: ${flow}
Overall Complexity: ${overallComplexity}

ACTIVITIES (brief):
${brief}

STRICT OUTPUT (JSON ONLY):
Return ONLY:
{
  "overall_reasoning": "..."
}

STYLE:
- Short, professional, implementation-focused
- Mention typical IFS technical work areas impacted (Aurena, Custom Objects, Events, Reports, Integrations) only if relevant
- Do not mention hours/days
`.trim();
}

async function openaiChatJson(prompt, providerConfig = {}) {
  const apiKey = safeTrim(providerConfig.apiKey) || safeTrim(process.env.OPENAI_API_KEY);
  const model = safeTrim(providerConfig.model) || 'gpt-4o-mini';
  const baseUrl = safeTrim(providerConfig.baseUrl) || 'https://api.openai.com';
  const timeoutMs = Number(providerConfig.timeoutMs) > 0 ? Number(providerConfig.timeoutMs) : 90000;
  if (!apiKey) return { ok: false, error: 'Missing OpenAI API Key (Settings or OPENAI_API_KEY)' };

  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const payload = {
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
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
      if (extracted) { try { parsed = JSON.parse(extracted); } catch { parsed = null; } }
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'OpenAI returned invalid JSON', detail: { raw: content } };
    return { ok: true, data: parsed };
  } catch (e) {
    const status = e?.response?.status;
    const msg = e?.response?.data?.error?.message || e?.message || 'OpenAI request failed';
    return { ok: false, error: msg, status, detail: e?.response?.data };
  }
}

async function azureChatJson(prompt, providerConfig = {}) {
  const endpoint = safeTrim(providerConfig.endpoint) || safeTrim(process.env.AZURE_OPENAI_ENDPOINT);
  const apiKey = safeTrim(providerConfig.apiKey) || safeTrim(process.env.AZURE_OPENAI_KEY);
  const deployment = safeTrim(providerConfig.deployment) || safeTrim(process.env.AZURE_OPENAI_DEPLOYMENT);
  const apiVersion =
    safeTrim(providerConfig.apiVersion) ||
    safeTrim(process.env.AZURE_OPENAI_API_VERSION) ||
    '2024-06-01';
  const timeoutMs = Number(providerConfig.timeoutMs) > 0 ? Number(providerConfig.timeoutMs) : 90000;

  if (!endpoint || !apiKey || !deployment) {
    return { ok: false, error: 'Missing Azure OpenAI configuration (endpoint/apiKey/deployment).' };
  }

  const base = endpoint.replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  const url =
    `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions` +
    `?api-version=${encodeURIComponent(apiVersion)}`;

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
      if (extracted) { try { parsed = JSON.parse(extracted); } catch { parsed = null; } }
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'Azure OpenAI returned invalid JSON', detail: { raw: content } };
    return { ok: true, data: parsed };
  } catch (e) {
    const status = e?.response?.status;
    const msg =
      e?.response?.data?.error?.message ||
      e?.response?.data?.message ||
      e?.message ||
      'Azure OpenAI request failed';
    return { ok: false, error: msg, status, detail: e?.response?.data };
  }
}

const sfdEstimationEngine = {
  /**
   * Process an SFD file path and return activity dev efforts + FINAL row.
   * @param {string} filePath
   * @param {{provider?:'openai'|'azure', config?:any}} options
   * @param {(progress:any)=>void} onProgress
   */
  async processSfdFile(filePath, options = {}, onProgress = null) {
    const provider = String(options.provider || 'openai').toLowerCase();
    const providerConfig = options.config || {};

    emitProgress(onProgress, { stage: 'start', percent: 0, message: 'Reading SFD document...' });

    const parsedDoc = await docxService.extractRawText(filePath);
    if (!parsedDoc.ok) return { ok: false, error: parsedDoc.error || 'Failed to parse SFD document' };

    const docText = clampText(parsedDoc.text, 24000);

    emitProgress(onProgress, { stage: 'ai_start', percent: 12, message: 'AI is extracting activities from SFD...' });

    let aiExtract;
    const extractPrompt = buildSfdPrompt(docText);
    if (provider === 'azure') aiExtract = await azureChatJson(extractPrompt, providerConfig);
    else if (provider === 'openai') aiExtract = await openaiChatJson(extractPrompt, providerConfig);
    else aiExtract = { ok: false, error: `SFD estimation supports only OpenAI/Azure. Selected: ${provider}` };

    if (!aiExtract.ok) return { ok: false, error: aiExtract.error || 'AI extraction failed', status: aiExtract.status, detail: aiExtract.detail };

    const direction = safeTrim(aiExtract.data?.direction) || 'N/A';
    const flow = safeTrim(aiExtract.data?.flow) || 'N/A';
    const rawActivities = Array.isArray(aiExtract.data?.activities) ? aiExtract.data.activities : [];

    emitProgress(onProgress, { stage: 'ai_done', percent: 30, message: `AI extracted ${rawActivities.length} activities` });

    const activityRows = [];
    const complexities = [];

    for (let i = 0; i < rawActivities.length; i += 1) {
      const a = rawActivities[i] || {};
      const idx = i + 1;

      emitProgress(onProgress, {
        stage: 'compute',
        percent: 30 + Math.round((idx * 55) / Math.max(1, rawActivities.length)),
        message: `Mapping effort for activity ${idx}/${rawActivities.length}`,
        index: idx,
        total: rawActivities.length,
      });

      const title = safeTrim(a.title) || `Activity ${idx}`;
      const goal = safeTrim(a.goal);
      const crimType = normalizeCrimType(a.crim_type);
      const complexity = normalizeComplexity(a.complexity);
      const aiReasoning = safeTrim(a.ai_reasoning);

      complexities.push(complexity);

      const base = resolveDevDaysFromMatrix(crimType, complexity);
      if (!base.ok) {
        activityRows.push({
          ok: false,
          kind: 'sfd_activity',
          title,
          summary: title,
          description: goal,
          crim_type: crimType,
          sub_type: '',
          complexity,
          error: base.error,
          reasoning: `Matrix mapping failed: ${base.error}`,
        });
        continue;
      }

      const devEffortDays = round1(base.days);
      const devEffortHours = round1(devEffortDays * HOURS_PER_DAY);

      // Per-activity reasoning remains “different for each activity”
      const reasoning = [
        goal ? `Goal: ${goal}` : null,
        `AI CRIM Type: ${base.type} (Subtype: ${base.subtype})`,
        `AI Complexity: ${complexity}`,
        aiReasoning ? `AI Reasoning: ${aiReasoning}` : null,
      ].filter(Boolean).join('\n\n');

      activityRows.push({
        ok: true,
        kind: 'sfd_activity',
        title,
        summary: title,
        description: goal,
        crim_type: base.type,
        sub_type: base.subtype,
        complexity,
        reasoning,
        devEffortDays,
        devEffortHours,
      });
    }

    const okActivities = activityRows.filter((r) => r && r.ok && r.kind === 'sfd_activity');
    const totalDevHours = round1(okActivities.reduce((a, r) => a + Number(r.devEffortHours || 0), 0));

    const overallComplexity = maxComplexity(complexities.length ? complexities : ['Medium']);
    const wbsPack = buildWbsFromTotalDev(totalDevHours);

    // ✅ Overall/common AI reasoning for CRIM
    emitProgress(onProgress, { stage: 'overall_reasoning', percent: 88, message: 'Generating overall AI reasoning...' });

    const activitiesBrief = okActivities.map((x) => ({
      title: x.title || x.summary,
      goal: x.description || '',
      crim_type: x.crim_type,
      complexity: x.complexity,
    }));

    const overallPrompt = buildOverallReasoningPrompt({
      direction,
      flow,
      overallComplexity,
      activitiesBrief,
    });

    let overallAi;
    if (provider === 'azure') overallAi = await azureChatJson(overallPrompt, providerConfig);
    else overallAi = await openaiChatJson(overallPrompt, providerConfig);

    const overallReasoning =
      safeTrim(overallAi?.data?.overall_reasoning) ||
      `Overall complexity "${overallComplexity}" based on the combined scope of extracted implementation activities across the SFD. Direction/Flow: ${direction}/${flow}.`;

    const finalRow = {
      ok: true,
      kind: 'sfd_final',
      summary: 'SFD FINAL',
      title: 'SFD FINAL',
      crim_type: 'SFD',
      sub_type: '',
      complexity: overallComplexity,
      direction,
      flow,

      // ✅ totals (NO E2E, NO Functional Spec)
      totalDevHours: wbsPack.totals.totalDevHours,
      totalDevSupportHours: wbsPack.totals.totalDevSupportHours,
      finalEffort: wbsPack.totals.totalEffortHours,
      hours: wbsPack.totals.totalEffortHours,
      totalEffortDays: wbsPack.totals.totalEffortDays,
      hoursPerDay: wbsPack.totals.hoursPerDay,

      // ✅ common WBS
      wbs: wbsPack.wbs,

      // ✅ for Jira comment
      sfdActivities: okActivities.map((x) => ({
        title: x.title || x.summary,
        devEffortHours: Number(x.devEffortHours || 0),
      })),

      // ✅ common reasoning shown near View WBS + posted to Jira comment
      reasoning: overallReasoning,
    };

    emitProgress(onProgress, { stage: 'done', percent: 100, message: 'SFD estimation completed' });

    return {
      ok: true,
      data: {
        stats: parsedDoc.stats,
        totalActivities: activityRows.length,
        successfulActivities: okActivities.length,
        totalDevHours,
        overallComplexity,
        direction,
        flow,
        final: finalRow,
        rows: [finalRow, ...activityRows],
      },
    };
  },
};

module.exports = { sfdEstimationEngine };