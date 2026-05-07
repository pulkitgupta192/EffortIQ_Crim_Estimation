// src/services/jiraService.js
// =========================================================
// EffortIQ Jira Service (Fully Fixed)
// - Test connection
// - Resolve custom field id by name (dynamic)
// - Detect Select-list fields and resolve option ids dynamically
// - Create issues (bulk loop with per-ticket error handling)
// - List projects for dropdown
// =========================================================

const axios = require('axios');

// Cache: field name => fieldId (per jiraUrl)
const fieldIdCache = new Map(); // key: `${jiraUrl}::${fieldName}` => fieldId|null

// Cache: fieldId => field definition (per jiraUrl)
const fieldDefCache = new Map(); // key: `${jiraUrl}::${fieldId}` => fieldDef|null

// Cache: select options (per jiraUrl + fieldId + contextId)
const fieldOptionsCache = new Map(); // key: `${jiraUrl}::${fieldId}::${contextId}` => Map(lowerValue => optionObj)

// Cache: field contexts (per jiraUrl + fieldId)
const fieldContextsCache = new Map(); // key: `${jiraUrl}::${fieldId}` => contexts[]

// -----------------------------
// Helpers
// -----------------------------
function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function buildAuthHeader(email, token) {
  const raw = `${String(email || '')}:${String(token || '')}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}
function toADF(text) {
   const safe = String(text ?? '').trim();
   const lines = safe ? safe.split(/\r?\n/) : [''];
   return {
     type: 'doc',
     version: 1,
     content: lines.map((line) => ({
       type: 'paragraph',
       content: [{ type: 'text', text: line }],
     })),
   };
 }
 
function adfTable(rows) {
  return {
    type: 'table',
    attrs: { isNumberColumnEnabled: false },
    content: rows.map(r => ({
      type: 'tableRow',
      content: r.map(cell => ({
        type: 'tableCell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: String(cell) }]
        }]
      }))
    }))
  };
}
 
// -----------------------------
// Timetracking helpers
// -----------------------------
// -----------------------------
// Timetracking update helpers
// -----------------------------
function secondsToDuration(seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.round(sec / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

async function updateIssueTimeTracking(jiraUrl, authHeader, issueKey, seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!issueKey || sec <= 0) return { ok: true, skipped: true };

  const duration = secondsToDuration(sec);

  // Jira Cloud-supported edit structure (string estimates)
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
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 60000,
    }
  );

  return { ok: true, duration };
}


// -----------------------------
// ADF helpers: text/marks
// -----------------------------
function adfText(text, marks = []) {
  const node = { type: "text", text: String(text ?? "") };
  if (marks.length) node.marks = marks;
  return node;
}

function markStrong() {
  return { type: "strong" };
}

// Atlassian textColor mark uses hex format, e.g. "#97a0af" [2](https://developer.atlassian.com/cloud/jira/platform/apis/document/marks/textColor/)
function markTextColor(hex) {
  return { type: "textColor", attrs: { color: hex } };
}

function paragraphFromTextNodes(textNodes = []) {
  return { type: "paragraph", content: textNodes.length ? textNodes : [adfText("")] };
}

// -----------------------------
// ADF helpers: table (with tableHeader + background)
// tableHeader supports attrs.background, colspan/rowspan, etc. [4](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/table_header/)
// -----------------------------
function tableHeaderCell(textNodes, backgroundHex = "#1D2B4F") {
  return {
    type: "tableHeader",
    attrs: { background: backgroundHex },
    content: [paragraphFromTextNodes(textNodes)],
  };
}

function tableCell(textNodes) {
  return {
    type: "tableCell",
    content: [paragraphFromTextNodes(textNodes)],
  };
}

function tableRow(cells) {
  return { type: "tableRow", content: cells };
}

function adfTable(headerCells, bodyRows) {
  return {
    type: "table",
    content: [
      tableRow(headerCells),
      ...bodyRows.map(r => tableRow(r)),
    ],
  };
}

// -----------------------------
// Collapsible section inside a table cell using nestedExpand
// nestedExpand is a container that allows content to be hidden/shown (accordion-like) [3](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/nestedExpand/)
// It can only be placed within a TableCell or TableHeader [3](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/nestedExpand/)[4](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/table_header/)
// -----------------------------
function nestedExpand(title, paragraphs) {
  return {
    type: "nestedExpand",
    attrs: { title: String(title ?? "") },
    content: paragraphs.map(p => ({
      type: "paragraph",
      content: [adfText(p)],
    })),
  };
}

// -----------------------------
// Simple color palette (hex)
// -----------------------------
const COLORS = {
  headerBg: "#172B4D",      // deep blue
  headerText: "#FFFFFF",
  key: "#4C9AFF",           // blue
  good: "#36B37E",          // green
  warn: "#FFAB00",          // amber
  bad: "#FF5630",           // red
  neutral: "#97A0AF",       // grey (example hex used in Atlassian docs) [2](https://developer.atlassian.com/cloud/jira/platform/apis/document/marks/textColor/)
};

function complexityColor(complexity) {
  const c = String(complexity ?? "").toLowerCase();
  if (c.includes("very complex") || c === "complex") return COLORS.bad;
  if (c === "medium") return COLORS.warn;
  if (c.includes("simple")) return COLORS.good;
  return COLORS.neutral;
}


// -----------------------------
// Jira Comment helpers (ADF)
// -----------------------------
function buildEstimationCommentADF(ticket) {
  const totalHours =
    Number(ticket?.totalHours) ||
    (Number(ticket?.customFields?.timeestimate) > 0
      ? Number(ticket.customFields.timeestimate) / 3600
      : 0);

  const complexity = String(ticket?.complexity ?? "N/A");
  const direction = String(ticket?.direction ?? "N/A");
  const flow = String(ticket?.flow ?? "N/A");
  const reasoning = String(ticket?.aiReasoning ?? "").trim() || "No AI reasoning provided.";

  // -----------------------------
  // 1) AI Effort Estimate Summary table
  // -----------------------------
  const summaryHeader = [
    tableHeaderCell([adfText("#", [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText("Field", [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText("Value", [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
  ];

  const summaryRowsRaw = [
    ["Complexity", complexity],
    ["Total Effort (h)", totalHours.toFixed(1)],
    ["Direction", direction],
    ["Flow", flow],
  ];

  const summaryBody = summaryRowsRaw.map(([k, v], idx) => {
    const isComplexity = k === "Complexity";
    const isTotal = k.startsWith("Total Effort");

    const valueColor = isComplexity
      ? complexityColor(v)
      : isTotal
        ? COLORS.key
        : COLORS.neutral;

    return [
      tableCell([adfText(String(idx + 1), [markStrong(), markTextColor(COLORS.neutral)])]),
      tableCell([adfText(k, [markStrong(), markTextColor(COLORS.key)])]),
      tableCell([adfText(v, [markStrong(), markTextColor(valueColor)])]),
    ];
  });

  const summaryTable = adfTable(summaryHeader, summaryBody);

  // -----------------------------
  // 2) WBS table (numbered)
  // -----------------------------
  const wbsEntries = Object.entries(ticket?.wbs || {})
    .map(([activity, hrs]) => ({
      activity: String(activity),
      hrs: Number(hrs || 0),
    }))
    .filter(x => Number.isFinite(x.hrs) && x.hrs > 0);

  const wbsHeader = [
    tableHeaderCell([adfText("#", [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText("Activity", [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
    tableHeaderCell([adfText("Effort", [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
  ];

  const wbsBody = (wbsEntries.length ? wbsEntries : [{ activity: "(No WBS available)", hrs: 0 }])
    .map((x, idx) => {
      const effortText = x.hrs ? `${x.hrs.toFixed(1)} h` : "-";
      const effortColor =
        x.hrs >= 4 ? COLORS.warn :
        x.hrs >= 2 ? COLORS.key :
        COLORS.neutral;

      return [
        tableCell([adfText(String(idx + 1), [markStrong(), markTextColor(COLORS.neutral)])]),
        tableCell([adfText(x.activity, [markStrong()])]),
        tableCell([adfText(effortText, [markStrong(), markTextColor(effortColor)])]),
      ];
    });

  const wbsTable = adfTable(wbsHeader, wbsBody);

  // -----------------------------
  // 3) Collapsed AI Reasoning using nestedExpand inside a 1-row table
  // -----------------------------
  const reasoningHeader = [
    tableHeaderCell([adfText("AI Reasoning (click to expand)", [markStrong(), markTextColor(COLORS.headerText)])], COLORS.headerBg),
  ];

  const reasoningBody = [
    [
      {
        type: "tableCell",
        content: [
          // nestedExpand must live inside TableCell/TableHeader [3](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/nestedExpand/)[4](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/table_header/)
          nestedExpand("AI Reasoning", [reasoning]),
        ],
      },
    ],
  ];

  const reasoningTable = {
    type: "table",
    content: [tableRow(reasoningHeader), ...reasoningBody.map(r => tableRow(r))],
  };

  // -----------------------------
  // Final ADF doc
  // ADF is used for Jira Cloud rich text fields like comments [1](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)[5](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)
  // -----------------------------
  return {
    type: "doc",
    version: 1,
    content: [
      { type: "heading", attrs: { level: 3 }, content: [adfText("AI Effort Estimate Summary", [markStrong()])] },
      summaryTable,

      { type: "heading", attrs: { level: 3 }, content: [adfText("Work Breakdown Structure", [markStrong()])] },
      wbsTable,

      // collapsed reasoning section
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

function lower(s) {
  return String(s ?? '').trim().toLowerCase();
}

function isSelectSingle(fieldDef) {
  // Most Jira select list (single) appears as schema.type === 'option'
  const type = fieldDef?.schema?.type;
  return type === 'option' || type === 'option-with-child';
}

function isSelectMulti(fieldDef) {
  // Multi-select commonly appears as schema.type === 'array' and schema.items === 'option'
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
    // Jira option has: { id, value, disabled, ... }
    const key = lower(opt?.value);
    if (key) map.set(key, opt);
  }

  fieldOptionsCache.set(cacheKey, map);
  return map;
}

/**
 * Try to resolve an option for a select field.
 * Prefers id-based payload: { id: "xxxxx" }
 */
async function resolveSelectOption(jiraUrl, authHeader, fieldId, desiredValue) {
  const wanted = lower(desiredValue);
  if (!wanted) return null;

  const contexts = await getFieldContexts(jiraUrl, authHeader, fieldId);
  if (!contexts.length) return null;

  // In most configurations you will have a single global context.
  // If multiple contexts exist (per project/issue type), we try them in order.
  for (const ctx of contexts) {
    const contextId = ctx?.id;
    if (!contextId) continue;

    const optionsMap = await getSelectOptionsMap(jiraUrl, authHeader, fieldId, contextId);
    const match = optionsMap.get(wanted);
    if (match?.id) return match;
  }

  return null;
}

/**
 * Resolve Jira field id by its display name (cached).
 */
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
   *
   * Renderer calls:
   *   window.api.jira.createTickets(tickets, jiraConfig, { crimFieldName:'C_CRIM_TYPE', failIfCrimFieldMissing:false })
   * [1](https://be4you-my.sharepoint.com/personal/pulkit_gupta_bearingpoint_com/Documents/Microsoft%20Copilot%20Chat%20Files/renderer.js)[3](https://be4you-my.sharepoint.com/personal/pulkit_gupta_bearingpoint_com/Documents/Microsoft%20Copilot%20Chat%20Files/index.js)
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
      } catch (e) {
        // Not fatal unless forced; we can still try value-based payload later
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
        results.push({
          ok: false,
          index: i,
          error: 'Missing required fields: project and summary are mandatory',
        });
        continue;
      }

      // Renderer sends: customFields.c_crim_type and customFields.timeestimate (seconds) [1](https://be4you-my.sharepoint.com/personal/pulkit_gupta_bearingpoint_com/Documents/Microsoft%20Copilot%20Chat%20Files/renderer.js)
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
        description: toADF(description),
      };

      // Original estimate in seconds
		  
		// if (hasSeconds) {
		  // const sec = Math.floor(seconds);
		  // fields.timetracking = {
		    // originalEstimateSeconds: sec,
		    // remainingEstimateSeconds: sec, // ✅ keep remaining aligned (optional but requested)
		  // };
		// }


      // 3) Set CRIM field correctly depending on schema
      if (crimFieldId && crimValue != null && String(crimValue).trim() !== '') {
        const rawVal = String(crimValue).trim();

        try {
          if (isSelectSingle(crimFieldDef)) {
            // Resolve option by value => use { id } (best)
            const opt = await resolveSelectOption(jiraUrl, authHeader, crimFieldId, rawVal);
            if (opt?.id) {
              fields[crimFieldId] = { id: opt.id };
            } else {
              // Fallback: some Jira configs accept value/name
              fields[crimFieldId] = { value: rawVal };
            }
          } else if (isSelectMulti(crimFieldDef)) {
            // Multi-select expects array of option objects
            // Support comma-separated values in Excel if ever needed.
            const parts = rawVal.split(',').map((x) => x.trim()).filter(Boolean);
            const chosen = [];
            for (const p of parts) {
              const opt = await resolveSelectOption(jiraUrl, authHeader, crimFieldId, p);
              if (opt?.id) chosen.push({ id: opt.id });
              else chosen.push({ value: p });
            }
            fields[crimFieldId] = chosen;
          } else {
            // If it’s not a select field, treat as plain value (text)
            fields[crimFieldId] = rawVal;
          }
        } catch (_e) {
          // If option resolution fails, attempt a safe fallback
          // Select-single fallback:
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

		// ✅ Update time tracking AFTER creation (reliable in Jira Cloud)
		let estimateStatus = { ok: true };
		try {
		  if (issueKey && hasSeconds) {
			estimateStatus = await updateIssueTimeTracking(jiraUrl, authHeader, issueKey, seconds);
		  }
		} catch (te) {
		  const payload = te?.response?.data;
		  estimateStatus = {
			ok: false,
			error: payload ? JSON.stringify(payload) : (te?.message || "Estimate update failed"),
		  };
		}

		// ✅ Post estimation comment: WBS + AI reasoning at the end
		let commentStatus = { ok: true };
		
		try {
		  // Only comment if we actually have something to post
		  const hasWbs = t?.wbs && typeof t.wbs === 'object' && Object.keys(t.wbs).length > 0;
		  const hasReason = String(t?.aiReasoning ?? '').trim().length > 0;
		  if (issueKey && (hasWbs || hasReason)) {
			 const adf = buildEstimationCommentADF(t);
			 //await addIssueComment(jiraUrl, authHeader, issueKey, adf);
			 
			 commentStatus = await addIssueComment(jiraUrl, authHeader, issueKey, adf);
		  }
		} 
		catch (ce) {
		  commentStatus = { ok: false, error: ce?.message || 'Failed to add comment' };
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
		});
		
      } catch (e) {
        const errPayload = e?.response?.data;
        const firstError =
          errPayload?.errorMessages?.[0] ||
          errPayload?.message ||
          (errPayload?.errors ? JSON.stringify(errPayload.errors) : null) ||
          e?.message ||
          'Failed to create issue';

        results.push({
          ok: false,
          index: i,
          error: firstError,
        });
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
