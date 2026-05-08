// src/services/jiraService.js
// =========================================================
// EffortIQ Jira Service
// - Test connection
// - Resolve custom field id by name (dynamic)
// - Detect Select-list fields and resolve option ids dynamically
// - Create issues (bulk loop with per-ticket error handling)
// - List projects for dropdown
// - ✅ NEW: Upload attachments (SFD DOCX) after issue creation
// =========================================================
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Cache: field name => fieldId (per jiraUrl)
const fieldIdCache = new Map(); // key: `${jiraUrl}::${fieldName}` => fieldId|null
// Cache: fieldId => field definition (per jiraUrl)
const fieldDefCache = new Map(); // key: `${jiraUrl}::${fieldId}` => fieldDef|null
// Cache: select options (per jiraUrl + fieldId + contextId)
const fieldOptionsCache = new Map(); // key: `${jiraUrl}::${fieldId}::${contextId}` => Map(lowerValue => optionObj)
// Cache: field contexts (per jiraUrl + fieldId)
const fieldContextsCache = new Map(); // key: `${jiraUrl}::${fieldId}` => contexts[]

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}
function buildAuthHeader(email, token) {
  const raw = `${String(email || '')}:${String(token || '')}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

// -----------------------------
// Timetracking helpers
// -----------------------------
function secondsToDuration(seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds || 0)));
  const minutes = Math.round(sec / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

async function updateIssueTimeTracking(jiraUrl, authHeader, issueKey, seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds || 0)));
  if (!issueKey || sec <= 0) return { ok: true, skipped: true };
  const duration = secondsToDuration(sec);

  await axios.put(
    `${jiraUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    {
      fields: {
        timetracking: {
          originalEstimate: duration,
          remainingEstimate: duration,
        },
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
// ADF helpers (minimal, same behavior as your existing file)
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
  return {
    type: 'tableHeader',
    attrs: { background: backgroundHex },
    content: [paragraphFromTextNodes(textNodes)],
  };
}
function tableCell(textNodes) {
  return { type: 'tableCell', content: [paragraphFromTextNodes(textNodes)] };
}
function tableRow(cells) {
  return { type: 'tableRow', content: cells };
}
function adfTable(headerCells, bodyRows) {
  return {
    type: 'table',
    content: [tableRow(headerCells), ...bodyRows.map((r) => tableRow(r))],
  };
}
function nestedExpand(title, paragraphs) {
  return {
    type: 'nestedExpand',
    attrs: { title: String(title ?? '') },
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: [adfText(p)],
    })),
  };
}

// Simple palette
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

function buildEstimationCommentADF(ticket) {
  const totalHours =
    Number(ticket?.totalHours) ||
    (Number(ticket?.customFields?.timeestimate) > 0
      ? Number(ticket.customFields.timeestimate) / 3600
      : 0);

  const complexity = String(ticket?.complexity ?? 'N/A');
  const direction = String(ticket?.direction ?? 'N/A');
  const flow = String(ticket?.flow ?? 'N/A');
  const reasoning =
    String(ticket?.aiReasoning ?? '').trim() || 'No AI reasoning provided.';

  // 1) Summary table
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
      tableCell([adfText(v, [markStrong(), markTextColor(valueColor)])]),
    ];
  });

  // 2) WBS table
  const wbsEntries = Object.entries(ticket?.wbs || {})
    .map(([activity, hrs]) => ({ activity: String(activity), hrs: Number(hrs || 0) }))
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

  // 3) Collapsed AI reasoning in nestedExpand inside a table cell
  const reasoningHeader = [
    tableHeaderCell(
      [adfText('AI Reasoning (click to expand)', [markStrong(), markTextColor(COLORS.headerText)])],
      COLORS.headerBg
    ),
  ];
  const reasoningTable = {
    type: 'table',
    content: [
      tableRow(reasoningHeader),
      tableRow([
        {
          type: 'tableCell',
          content: [nestedExpand('AI Reasoning', [reasoning])],
        },
      ]),
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
// Select field helpers (same behavior)
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
  const resp = await axios.get(
    `${jiraUrl}/rest/api/3/field/${fieldId}/context/${contextId}/option`,
    {
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 30000,
    }
  );
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
  const name = String(fieldName || '').trim();
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
// ✅ NEW: Attachment upload (multipart/form-data)
// -----------------------------
async function uploadIssueAttachments(jiraUrl, authHeader, issueKey, filePaths = []) {
  const files = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [];
  if (!issueKey || files.length === 0) return { ok: true, skipped: true, uploaded: 0 };

  let FormData;
  try {
    FormData = require('form-data');
  } catch (e) {
    return {
      ok: false,
      error: "Missing dependency 'form-data'. Install with: npm i form-data",
    };
  }

  const uploaded = [];
  const errors = [];

  for (const fp of files) {
    try {
      if (!fs.existsSync(fp)) {
        errors.push({ file: fp, error: 'File not found' });
        continue;
      }

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
        e?.response?.data?.errorMessages?.[0] ||
        e?.response?.data?.message ||
        e?.message ||
        'Attachment upload failed';
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
        error?.response?.data?.errorMessages?.[0] ||
          error?.response?.data?.message ||
          error.message
      );
    }
  },

  /**
   * Bulk create tickets (sequential, with per-ticket error collection).
   * Supports optional:
   * - ticket.wbs, ticket.aiReasoning, ticket.totalHours (for comment)
   * - ticket.customFields.timeestimate (seconds)
   * - ✅ ticket.attachments: [filePath] (will be uploaded after creation)
   */
  async createBulkTickets(tickets, jiraConfig, options = {}) {
    const jiraUrl = normalizeUrl(jiraConfig?.url);
    const email = jiraConfig?.email;
    const token = jiraConfig?.token;

    if (!jiraUrl || !email || !token) {
      return { ok: false, error: 'Missing Jira configuration (url/email/token)' };
    }
    const authHeader = buildAuthHeader(email, token);
    const input = Array.isArray(tickets) ? tickets : [];

    const crimFieldName = options?.crimFieldName || 'C_CRIM_TYPE';
    const failIfCrimFieldMissing = Boolean(options?.failIfCrimFieldMissing);

    // 1) Resolve custom field id from display name
    let crimFieldId = null;
    try {
      crimFieldId = await resolveCustomFieldIdByName(jiraConfig, crimFieldName);
    } catch (e) {
      if (failIfCrimFieldMissing) {
        return { ok: false, error: `Failed to resolve field '${crimFieldName}': ${e.message}` };
      }
    }

    if (!crimFieldId && failIfCrimFieldMissing) {
      return { ok: false, error: `Custom field '${crimFieldName}' not found in Jira` };
    }

    // 2) Load field definition once (if field exists)
    let crimFieldDef = null;
    if (crimFieldId) {
      try {
        crimFieldDef = await getFieldDefinition(jiraUrl, authHeader, crimFieldId);
      } catch {
        crimFieldDef = null;
      }
    }

    const results = [];
    let created = 0;

    for (let i = 0; i < input.length; i += 1) {
      const t = input[i] || {};
      const projectKey = String(t.project || '').trim();
      const issueType = String(t.issueType || 'Task').trim();
      const summary = String(t.summary || '').trim();
      const description = String(t.description || '').trim();

      if (!projectKey || !summary) {
        results.push({ ok: false, index: i, error: 'Missing required fields: project and summary are mandatory' });
        continue;
      }

      const customFields = t.customFields || {};
      const crimValue =
        customFields.c_crim_type ??
        customFields.crim_type ??
        t.crim_type ??
        null;

      const seconds = Number(customFields.timeestimate);
      const hasSeconds = Number.isFinite(seconds) && seconds > 0;

      const fields = {
        project: { key: projectKey },
        issuetype: { name: issueType },
        summary,
        // Keep description as plain text (ADF) - simplest compatibility
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: description }],
            },
          ],
        },
      };

      // 3) Set CRIM field depending on schema
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

      // 4) Create issue
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

        // 5) Update time tracking AFTER creation
        let estimateStatus = { ok: true };
        try {
          if (issueKey && hasSeconds) {
            estimateStatus = await updateIssueTimeTracking(jiraUrl, authHeader, issueKey, seconds);
          }
        } catch (te) {
          const payload = te?.response?.data;
          estimateStatus = {
            ok: false,
            error: payload ? JSON.stringify(payload) : (te?.message || 'Estimate update failed'),
          };
        }

        // 6) Post estimation comment (WBS + Reasoning)
        let commentStatus = { ok: true };
        try {
          const hasWbs = t?.wbs && typeof t.wbs === 'object' && Object.keys(t.wbs).length > 0;
          const hasReason = String(t?.aiReasoning ?? '').trim().length > 0;
          if (issueKey && (hasWbs || hasReason)) {
            const adf = buildEstimationCommentADF(t);
            commentStatus = await addIssueComment(jiraUrl, authHeader, issueKey, adf);
          }
        } catch (ce) {
          commentStatus = { ok: false, error: ce?.message || 'Failed to add comment' };
        }

        // ✅ NEW: Upload attachments (if provided)
        let attachmentStatus = { ok: true, skipped: true, uploaded: 0 };
        try {
          const attachments = Array.isArray(t.attachments) ? t.attachments : [];
          if (issueKey && attachments.length) {
            attachmentStatus = await uploadIssueAttachments(jiraUrl, authHeader, issueKey, attachments);
          }
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
          errPayload?.errorMessages?.[0] ||
          errPayload?.message ||
          (errPayload?.errors ? JSON.stringify(errPayload.errors) : null) ||
          e?.message ||
          'Failed to create issue';
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