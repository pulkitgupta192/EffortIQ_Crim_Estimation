// src/services/jiraService.js
// =========================================================
// EffortIQ Jira Service
// - Test connection
// - Resolve custom field id by name (dynamic)
// - Detect Select-list fields and resolve option ids dynamically
// - Create issues (bulk loop with per-ticket error handling)
// - List projects
// - Upload attachments (SFD DOCX) after issue creation
// - ✅ SFD comment: activities dev effort + totals + WBS summary
// =========================================================
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Cache: field name => fieldId (per jiraUrl)
const fieldIdCache = new Map();
// Cache: fieldId => field definition (per jiraUrl)
const fieldDefCache = new Map();
// Cache: select options (per jiraUrl + fieldId + contextId)
const fieldOptionsCache = new Map();
// Cache: field contexts (per jiraUrl + fieldId)
const fieldContextsCache = new Map();

function normalizeUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}
function buildAuthHeader(email, token) {
  const raw = `${String(email ?? '')}:${String(token ?? '')}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

// -----------------------------
// Timetracking helpers
// -----------------------------
function secondsToDuration(seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds ?? 0)));
  const minutes = Math.round(sec / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

async function updateIssueTimeTracking(jiraUrl, authHeader, issueKey, seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds ?? 0)));
  if (!issueKey || sec <= 0) return { ok: true, skipped: true };
  const duration = secondsToDuration(sec);

  await axios.put(
    `${jiraUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    {
      fields: {
        timetracking: { originalEstimate: duration, remainingEstimate: duration },
      },
    },
    {
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 60000,
    }
  );
  return { ok: true, duration };
}

// -----------------------------
// ADF helpers (minimal)
// -----------------------------
function adfText(text, marks = []) {
  const node = { type: 'text', text: String(text ?? '') };
  if (marks.length) node.marks = marks;
  return node;
}
function markStrong() { return { type: 'strong' }; }
function markTextColor(hex) { return { type: 'textColor', attrs: { color: hex } }; }
function paragraphFromTextNodes(textNodes = []) {
  return { type: 'paragraph', content: textNodes.length ? textNodes : [adfText('')] };
}
function tableHeaderCell(textNodes, backgroundHex = '#172B4D') {
  return { type: 'tableHeader', attrs: { background: backgroundHex }, content: [paragraphFromTextNodes(textNodes)] };
}
function tableCell(textNodes) {
  return { type: 'tableCell', content: [paragraphFromTextNodes(textNodes)] };
}
function tableRow(cells) { return { type: 'tableRow', content: cells }; }
function adfTable(headerCells, bodyRows) {
  return { type: 'table', content: [tableRow(headerCells), ...bodyRows.map((r) => tableRow(r))] };
}
function nestedExpand(title, paragraphs) {
  return {
    type: 'nestedExpand',
    attrs: { title: String(title ?? '') },
    content: paragraphs.map((p) => ({ type: 'paragraph', content: [adfText(p)] })),
  };
}

const COLORS = {
  headerBg: '#172B4D',
  headerText: '#FFFFFF',
  key: '#4C9AFF',
  good: '#36B37E',
  warn: '#FFAB00',
  bad: '#FF5630',
  neutral: '#97A0AF',
};

function complexityColor(complexity) {
  const c = String(complexity ?? '').toLowerCase();
  if (c.includes('very complex') || c === 'complex') return COLORS.bad;
  if (c === 'medium') return COLORS.warn;
  if (c.includes('simple')) return COLORS.good;
  return COLORS.neutral;
}

// ✅ SFD comment builder (your requested structure)
function buildSfdEstimationCommentADF(ticket) {
  const complexity = String(ticket?.complexity ?? 'N/A');
  const direction = String(ticket?.direction ?? 'N/A');
  const flow = String(ticket?.flow ?? 'N/A');

  const totalHours =
    Number(ticket?.totalHours) ||
    (Number(ticket?.customFields?.timeestimate) > 0 ? Number(ticket.customFields.timeestimate) / 3600 : 0);

  const activities = Array.isArray(ticket?.sfdActivities) ? ticket.sfdActivities : [];
  const wbs = ticket?.wbs && typeof ticket.wbs === 'object' ? ticket.wbs : {};

  const devRows = activities
    .map((a, i) => ({
      idx: i + 1,
      title: String(a?.title ?? '').trim() || `Activity ${i + 1}`,
      dev: Number(a?.devEffortHours ?? 0),
    }))
    .filter((x) => x.dev >= 0);

  const totalDevEffort = devRows.reduce((s, r) => s + r.dev, 0);

  const unitTesting = Number(wbs['Unit Testing'] ?? 0);
  const codeReview = Number(wbs['Code Review'] ?? 0);
  const documentation = Number(wbs['Documentation'] ?? 0);
  const codeManagement = Number(wbs['Code Management'] ?? 0);

  const totalDevSupport = unitTesting + codeReview + documentation + codeManagement;
  const finalDevEffort = totalDevEffort + totalDevSupport;

  const e2e = Number(wbs['End-to-End Testing'] ?? 0);
  const fspec = Number(wbs['Functional Specification'] ?? 0);

  const totalEffort = Number(
    wbs['Development'] ?? 0
  ) + totalDevSupport + e2e + fspec;

  // 1) Summary table
  const summaryHeader = [
    tableHeaderCell([adfText('#', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText('Field', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText('Value', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
  ];
  const summaryRowsRaw = [
    ['Complexity', complexity],
    ['Direction', direction],
    ['Flow', flow],
    ['Total Effort (h)', totalHours.toFixed(1)],
  ];
  const summaryBody = summaryRowsRaw.map(([k, v], idx) => {
    const isComplexity = k === 'Complexity';
    const isTotal = k.startsWith('Total Effort');
    const valueColor = isComplexity ? complexityColor(v) : isTotal ? COLORS.key : COLORS.neutral;
    return [
      tableCell([adfText(String(idx + 1), [markStrong(), markTextColor(COLORS.neutral)])]),
      tableCell([adfText(k, [markStrong(), markTextColor(COLORS.key)])]),
      tableCell([adfText(String(v), [markStrong(), markTextColor(valueColor)])]),
    ];
  });

  // 2) Activities table (serial + DEV effort)
  const actHeader = [
    tableHeaderCell([adfText('#', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText('Activity', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText('Dev Effort (h)', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
  ];
  const actBody = devRows.map((r) => ([
    tableCell([adfText(String(r.idx), [markStrong(), markTextColor(COLORS.neutral)])]),
    tableCell([adfText(r.title, [markStrong()])]),
    tableCell([adfText(r.dev.toFixed(1), [markStrong(), markTextColor(COLORS.key)])]),
  ]));

  // Total Dev Effort row
  actBody.push([
    tableCell([adfText('', [])]),
    tableCell([adfText('Total Dev Effort', [markStrong(), markTextColor(COLORS.good)])]),
    tableCell([adfText(totalDevEffort.toFixed(1), [markStrong(), markTextColor(COLORS.good)])]),
  ]);

  // 3) Dev Support Activities table
  const supHeader = [
    tableHeaderCell([adfText('Dev Support Activities', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText('Effort (h)', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
  ];
  const supBody = [
    [tableCell([adfText('Code Review', [markStrong()])]), tableCell([adfText(codeReview.toFixed(1), [markStrong(), markTextColor(COLORS.key)])])],
    [tableCell([adfText('Unit Testing', [markStrong()])]), tableCell([adfText(unitTesting.toFixed(1), [markStrong(), markTextColor(COLORS.key)])])],
    [tableCell([adfText('Documentation', [markStrong()])]), tableCell([adfText(documentation.toFixed(1), [markStrong(), markTextColor(COLORS.key)])])],
    [tableCell([adfText('Code Management', [markStrong()])]), tableCell([adfText(codeManagement.toFixed(1), [markStrong(), markTextColor(COLORS.key)])])],
    [tableCell([adfText('Total Dev Support Activities', [markStrong(), markTextColor(COLORS.good)])]), tableCell([adfText(totalDevSupport.toFixed(1), [markStrong(), markTextColor(COLORS.good)])])],
    [tableCell([adfText('Final Dev Effort (Dev + Support)', [markStrong(), markTextColor(COLORS.good)])]), tableCell([adfText(finalDevEffort.toFixed(1), [markStrong(), markTextColor(COLORS.good)])])],
  ];

  // 4) Additional section (E2E + FS)
  const addHeader = [
    tableHeaderCell([adfText('Additional Activities', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText('Effort (h)', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
  ];
  const addBody = [
    [tableCell([adfText('End to End Testing', [markStrong()])]), tableCell([adfText(e2e.toFixed(1), [markStrong(), markTextColor(COLORS.key)])])],
    [tableCell([adfText('Functional Specification', [markStrong()])]), tableCell([adfText(fspec.toFixed(1), [markStrong(), markTextColor(COLORS.key)])])],
    [tableCell([adfText('Total Effort', [markStrong(), markTextColor(COLORS.bad)])]), tableCell([adfText(totalEffort.toFixed(1), [markStrong(), markTextColor(COLORS.bad)])])],
  ];

  // 5) Reasoning collapsible
  const reasoning = String(ticket?.aiReasoning ?? '').trim() || 'No AI reasoning provided.';
  const reasoningHeader = [
    tableHeaderCell([adfText('AI Reasoning (click to expand)', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
  ];
  const reasoningTable = {
    type: 'table',
    content: [
      tableRow(reasoningHeader),
      tableRow([{
        type: 'tableCell',
        content: [nestedExpand('AI Reasoning', [reasoning])],
      }]),
    ],
  };

  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 3 }, content: [adfText('SFD Estimate Summary', [markStrong()])] },
      adfTable(summaryHeader, summaryBody),

      { type: 'heading', attrs: { level: 3 }, content: [adfText('Activities (Dev Effort)', [markStrong()])] },
      adfTable(actHeader, actBody),

      { type: 'heading', attrs: { level: 3 }, content: [adfText('Dev Support Activities', [markStrong()])] },
      adfTable(supHeader, supBody),

      { type: 'heading', attrs: { level: 3 }, content: [adfText('Additional Activities', [markStrong()])] },
      adfTable(addHeader, addBody),

      reasoningTable,
    ],
  };
}

// Existing XLSX comment builder remains as-is
function buildStandardEstimationCommentADF(ticket) {
  const totalHours =
    Number(ticket?.totalHours) ||
    (Number(ticket?.customFields?.timeestimate) > 0 ? Number(ticket.customFields.timeestimate) / 3600 : 0);

  const complexity = String(ticket?.complexity ?? 'N/A');
  const direction = String(ticket?.direction ?? 'N/A');
  const flow = String(ticket?.flow ?? 'N/A');
  const reasoning = String(ticket?.aiReasoning ?? '').trim() || 'No AI reasoning provided.';

  const summaryHeader = [
    tableHeaderCell([adfText('#', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText('Field', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText('Value', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
  ];
  const summaryRowsRaw = [
    ['Complexity', complexity],
    ['Total Effort (h)', totalHours.toFixed(1)],
    ['Direction', direction],
    ['Flow', flow],
  ];
  const summaryBody = summaryRowsRaw.map(([k, v], idx) => {
    const isComplexity = k === 'Complexity';
    const isTotal = k.startsWith('Total Effort');
    const valueColor = isComplexity ? complexityColor(v) : isTotal ? COLORS.key : COLORS.neutral;
    return [
      tableCell([adfText(String(idx + 1), [markStrong(), markTextColor(COLORS.neutral)])]),
      tableCell([adfText(k, [markStrong(), markTextColor(COLORS.key)])]),
      tableCell([adfText(String(v), [markStrong(), markTextColor(valueColor)])]),
    ];
  });

  const wbsEntries = Object.entries(ticket?.wbs ?? {})
    .map(([activity, hrs]) => ({ activity: String(activity), hrs: Number(hrs ?? 0) }))
    .filter((x) => Number.isFinite(x.hrs) && x.hrs > 0);

  const wbsHeader = [
    tableHeaderCell([adfText('#', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText('Activity', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText('Effort', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
  ];
  const wbsBody = (wbsEntries.length ? wbsEntries : [{ activity: '(No WBS available)', hrs: 0 }]).map((x, idx) => {
    const effortText = x.hrs ? `${x.hrs.toFixed(1)} h` : '-';
    const effortColor = x.hrs >= 4 ? COLORS.warn : x.hrs >= 2 ? COLORS.key : COLORS.neutral;
    return [
      tableCell([adfText(String(idx + 1), [markStrong(), markTextColor(COLORS.neutral)])]),
      tableCell([adfText(x.activity, [markStrong()])]),
      tableCell([adfText(effortText, [markStrong(), markTextColor(effortColor)])]),
    ];
  });

  const reasoningHeader = [
    tableHeaderCell([adfText('AI Reasoning (click to expand)', [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
  ];
  const reasoningTable = {
    type: 'table',
    content: [
      tableRow(reasoningHeader),
      tableRow([{
        type: 'tableCell',
        content: [nestedExpand('AI Reasoning', [reasoning])],
      }]),
    ],
  };

  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 3 }, content: [adfText('AI Effort Estimate Summary', [markStrong()])] },
      adfTable(summaryHeader, summaryBody),
      { type: 'heading', attrs: { level: 3 }, content: [adfText('Work Breakdown Structure', [markStrong()])] },
      adfTable(wbsHeader, wbsBody),
      reasoningTable,
    ],
  };
}

async function addIssueComment(jiraUrl, authHeader, issueKeyOrId, adfDoc) {
  await axios.post(
    `${jiraUrl}/rest/api/3/issue/${encodeURIComponent(issueKeyOrId)}/comment`,
    { body: adfDoc },
    {
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 60000,
    }
  );
  return { ok: true };
}

// -----------------------------
// Select field helpers
// -----------------------------
function lower(s) { return String(s ?? '').trim().toLowerCase(); }
function isSelectSingle(fieldDef) {
  const type = fieldDef?.schema?.type;
  return type === 'option' || type === 'option-with-child';
}
function isSelectMulti(fieldDef) {
  const type = fieldDef?.schema?.type;
  const items = fieldDef?.schema?.items;
  return type === 'array' && (items === 'option' || items === 'option-with-child');
}

async function fetchAllFields(jiraUrl, authHeader) {
  const resp = await axios.get(`${jiraUrl}/rest/api/3/field`, {
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 30000,
  });
  return Array.isArray(resp.data) ? resp.data : [];
}

async function getFieldDefinition(jiraUrl, authHeader, fieldId) {
  const cacheKey = `${jiraUrl}::${fieldId}`;
  if (fieldDefCache.has(cacheKey)) return fieldDefCache.get(cacheKey);
  const all = await fetchAllFields(jiraUrl, authHeader);
  const def = all.find((f) => f?.id === fieldId) || null;
  fieldDefCache.set(cacheKey, def);
  return def;
}

async function getFieldContexts(jiraUrl, authHeader, fieldId) {
  const cacheKey = `${jiraUrl}::${fieldId}`;
  if (fieldContextsCache.has(cacheKey)) return fieldContextsCache.get(cacheKey);

  const resp = await axios.get(`${jiraUrl}/rest/api/3/field/${fieldId}/context`, {
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  const contexts = resp.data?.values || [];
  fieldContextsCache.set(cacheKey, contexts);
  return contexts;
}

async function getSelectOptionsMap(jiraUrl, authHeader, fieldId, contextId) {
  const cacheKey = `${jiraUrl}::${fieldId}::${contextId}`;
  if (fieldOptionsCache.has(cacheKey)) return fieldOptionsCache.get(cacheKey);

  const resp = await axios.get(`${jiraUrl}/rest/api/3/field/${fieldId}/context/${contextId}/option`, {
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  const options = resp.data?.values || [];
  const map = new Map();
  for (const opt of options) {
    const key = lower(opt?.value);
    if (key) map.set(key, opt);
  }
  fieldOptionsCache.set(cacheKey, map);
  return map;
}

async function resolveSelectOption(jiraUrl, authHeader, fieldId, desiredValue) {
  const wanted = lower(desiredValue);
  if (!wanted) return null;

  const contexts = await getFieldContexts(jiraUrl, authHeader, fieldId);
  if (!contexts.length) return null;

  for (const ctx of contexts) {
    const contextId = ctx?.id;
    if (!contextId) continue;
    const optionsMap = await getSelectOptionsMap(jiraUrl, authHeader, fieldId, contextId);
    const match = optionsMap.get(wanted);
    if (match?.id) return match;
  }
  return null;
}

async function resolveCustomFieldIdByName(jiraConfig, fieldName) {
  const jiraUrl = normalizeUrl(jiraConfig?.url);
  const name = String(fieldName ?? '').trim();
  if (!jiraUrl || !name) return null;

  const cacheKey = `${jiraUrl}::${name}`;
  if (fieldIdCache.has(cacheKey)) return fieldIdCache.get(cacheKey);

  const resp = await axios.get(`${jiraUrl}/rest/api/3/field`, {
    headers: {
      Authorization: buildAuthHeader(jiraConfig.email, jiraConfig.token),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  const fields = Array.isArray(resp.data) ? resp.data : [];
  const match = fields.find((f) => f && f.name === name);
  const fieldId = match?.id || null;
  fieldIdCache.set(cacheKey, fieldId);
  return fieldId;
}

// -----------------------------
// Attachment upload
// -----------------------------
async function uploadIssueAttachments(jiraUrl, authHeader, issueKey, filePaths = []) {
  const files = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [];
  if (!issueKey || files.length === 0) return { ok: true, skipped: true, uploaded: 0 };

  let FormData;
  try { FormData = require('form-data'); }
  catch (e) {
    return { ok: false, error: "Missing dependency 'form-data'. Install with: npm i form-data" };
  }

  const uploaded = [];
  const errors = [];

  for (const fp of files) {
    try {
      if (!fs.existsSync(fp)) { errors.push({ file: fp, error: 'File not found' }); continue; }
      const form = new FormData();
      form.append('file', fs.createReadStream(fp), path.basename(fp));

      const resp = await axios.post(
        `${jiraUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`,
        form,
        {
          headers: {
            Authorization: authHeader,
            Accept: 'application/json',
            'X-Atlassian-Token': 'no-check',
            ...form.getHeaders(),
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 120000,
        }
      );
      uploaded.push({ file: fp, response: resp?.data });
    } catch (e) {
      const msg =
        e?.response?.data?.errorMessages?.[0]
        || e?.response?.data?.message
        || e?.message
        || 'Attachment upload failed';
      errors.push({ file: fp, error: msg });
    }
  }

  return { ok: errors.length === 0, uploaded: uploaded.length, uploadedFiles: uploaded, errors };
}

// =========================================================
// Service
// =========================================================
const jiraService = {
  async testConnection(config) {
    try {
      const jiraUrl = normalizeUrl(config.url);
      const response = await axios.get(`${jiraUrl}/rest/api/3/myself`, {
        headers: {
          Authorization: buildAuthHeader(config.email, config.token),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 30000,
      });
      return { ok: true, user: response.data.displayName };
    } catch (error) {
      throw new Error(
        error?.response?.data?.errorMessages?.[0]
        || error?.response?.data?.message
        || error.message
      );
    }
  },

  async createBulkTickets(tickets, jiraConfig, options = {}) {
    const jiraUrl = normalizeUrl(jiraConfig?.url);
    const email = jiraConfig?.email;
    const token = jiraConfig?.token;
    if (!jiraUrl || !email || !token) return { ok: false, error: 'Missing Jira configuration (url/email/token)' };

    const authHeader = buildAuthHeader(email, token);
    const input = Array.isArray(tickets) ? tickets : [];
    const crimFieldName = options?.crimFieldName || 'C_CRIM_TYPE';
    const failIfCrimFieldMissing = Boolean(options?.failIfCrimFieldMissing);

    let crimFieldId = null;
    try { crimFieldId = await resolveCustomFieldIdByName(jiraConfig, crimFieldName); }
    catch (e) { if (failIfCrimFieldMissing) return { ok: false, error: `Failed to resolve field '${crimFieldName}': ${e.message}` }; }

    if (!crimFieldId && failIfCrimFieldMissing) return { ok: false, error: `Custom field '${crimFieldName}' not found in Jira` };

    let crimFieldDef = null;
    if (crimFieldId) {
      try { crimFieldDef = await getFieldDefinition(jiraUrl, authHeader, crimFieldId); }
      catch { crimFieldDef = null; }
    }

    const results = [];
    let created = 0;

    for (let i = 0; i < input.length; i += 1) {
      const t = input[i] || {};
      const projectKey = String(t.project ?? '').trim();
      const issueType = String(t.issueType ?? 'Task').trim();
      const summary = String(t.summary ?? '').trim();
      const description = String(t.description ?? '').trim();

      if (!projectKey || !summary) {
        results.push({ ok: false, index: i, error: 'Missing required fields: project and summary are mandatory' });
        continue;
      }

      const customFields = t.customFields || {};
      const crimValue = customFields.c_crim_type ?? customFields.crim_type ?? t.crim_type ?? null;
      const seconds = Number(customFields.timeestimate);
      const hasSeconds = Number.isFinite(seconds) && seconds > 0;

      const fields = {
        project: { key: projectKey },
        issuetype: { name: issueType },
        summary,
        description: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
        },
      };

      if (crimFieldId && crimValue != null && String(crimValue).trim() !== '') {
        const rawVal = String(crimValue).trim();
        try {
          if (isSelectSingle(crimFieldDef)) {
            const opt = await resolveSelectOption(jiraUrl, authHeader, crimFieldId, rawVal);
            fields[crimFieldId] = opt?.id ? { id: opt.id } : { value: rawVal };
          } else if (isSelectMulti(crimFieldDef)) {
            const parts = rawVal.split(',').map((x) => x.trim()).filter(Boolean);
            const chosen = [];
            for (const p of parts) {
              const opt = await resolveSelectOption(jiraUrl, authHeader, crimFieldId, p);
              chosen.push(opt?.id ? { id: opt.id } : { value: p });
            }
            fields[crimFieldId] = chosen;
          } else {
            fields[crimFieldId] = rawVal;
          }
        } catch {
          fields[crimFieldId] = { value: rawVal };
        }
      }

      try {
        const resp = await axios.post(`${jiraUrl}/rest/api/3/issue`, { fields }, {
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 60000,
        });

        created += 1;
        const issueKey = resp.data?.key;

        let estimateStatus = { ok: true };
        try { if (issueKey && hasSeconds) estimateStatus = await updateIssueTimeTracking(jiraUrl, authHeader, issueKey, seconds); }
        catch (te) {
          const payload = te?.response?.data;
          estimateStatus = { ok: false, error: payload ? JSON.stringify(payload) : (te?.message || 'Estimate update failed') };
        }

        // ✅ Comment: choose SFD comment format if sfdActivities exist
        let commentStatus = { ok: true };
        try {
          const hasReason = String(t?.aiReasoning ?? '').trim().length > 0;
          const hasWbs = t?.wbs && typeof t.wbs === 'object' && Object.keys(t.wbs).length > 0;
          const hasSfdActivities = Array.isArray(t?.sfdActivities) && t.sfdActivities.length > 0;

          if (issueKey && (hasReason || hasWbs || hasSfdActivities)) {
            const adf = hasSfdActivities ? buildSfdEstimationCommentADF(t) : buildStandardEstimationCommentADF(t);
            commentStatus = await addIssueComment(jiraUrl, authHeader, issueKey, adf);
          }
        } catch (ce) {
          commentStatus = { ok: false, error: ce?.message || 'Failed to add comment' };
        }

        let attachmentStatus = { ok: true, skipped: true, uploaded: 0 };
        try {
          const attachments = Array.isArray(t.attachments) ? t.attachments : [];
          if (issueKey && attachments.length) attachmentStatus = await uploadIssueAttachments(jiraUrl, authHeader, issueKey, attachments);
        } catch (ae) {
          attachmentStatus = { ok: false, error: ae?.message || 'Attachment upload failed' };
        }

        results.push({
          ok: true,
          index: i,
          key: issueKey,
          id: resp.data?.id,
          self: resp.data?.self,
          estimateOk: estimateStatus.ok,
          estimateError: estimateStatus.ok ? null : estimateStatus.error,
          commentOk: commentStatus.ok,
          commentError: commentStatus.ok ? null : commentStatus.error,
          attachmentsOk: attachmentStatus.ok,
          attachmentsUploaded: attachmentStatus.uploaded ?? 0,
          attachmentsError: attachmentStatus.ok ? null : (attachmentStatus.error || attachmentStatus.errors),
        });
      } catch (e) {
        const errPayload = e?.response?.data;
        const firstError =
          errPayload?.errorMessages?.[0]
          || errPayload?.message
          || (errPayload?.errors ? JSON.stringify(errPayload.errors) : null)
          || e?.message
          || 'Failed to create issue';
        results.push({ ok: false, index: i, error: firstError });
      }
    }

    return {
      ok: true,
      total: input.length,
      created,
      results,
      crimFieldName,
      crimFieldId: crimFieldId || null,
    };
  },

  async listProjects(jiraConfig, options = {}) {
    const jiraUrl = normalizeUrl(jiraConfig.url);
    const authHeader = buildAuthHeader(jiraConfig.email, jiraConfig.token);
    const maxResults = options.maxResults ?? 200;
    const startAt = options.startAt ?? 0;

    const response = await axios.get(
      `${jiraUrl}/rest/api/3/project/search?startAt=${startAt}&maxResults=${maxResults}`,
      {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 30000,
      }
    );

    const values = response.data?.values ?? [];
    return {
      ok: true,
      projects: values.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        projectTypeKey: p.projectTypeKey,
      })),
      startAt: response.data?.startAt ?? 0,
      maxResults: response.data?.maxResults ?? maxResults,
      total: response.data?.total ?? values.length,
    };
  },

  resolveCustomFieldIdByName,
};

module.exports = { jiraService };