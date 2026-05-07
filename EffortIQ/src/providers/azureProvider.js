'use strict';

// src/providers/azureProvider.js
// =========================================================
// EffortIQ Azure OpenAI Provider (Production-ready)
// - Calls Azure OpenAI Chat Completions via deployment endpoint
// - Uses api-version query parameter
// - Attempts strict JSON output using response_format=json_object (if supported)
// - Robust parsing fallback if upstream adds extra text
// - Retries for 429/5xx/timeouts with exponential backoff + jitter
// - Returns stable contract:
//   { ok: true, meta: { complexity, direction, flow, reason } }
//   { ok: false, error, status?, detail? }
// =========================================================

const axios = require('axios');

const DEFAULT_API_VERSION = '2024-06-01';
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TEXT_LEN = 800;

const ALLOWED_COMPLEXITIES = new Set([
  'Very Simple',
  'Simple',
  'Medium',
  'Complex',
  'Very Complex',
]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeTrim(v) {
  return String(v ?? '').trim();
}

function clampText(text, maxLen) {
  const s = safeTrim(text);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function normalizeComplexity(v) {
  const s = safeTrim(v);
  return ALLOWED_COMPLEXITIES.has(s) ? s : 'Medium';
}

function normalizeEndpoint(endpoint) {
  // Remove wrapping quotes and trailing slashes
  const e = safeTrim(endpoint).replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  return e;
}

function extractJsonObject(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function buildErrorMessage(err) {
  return (
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.response?.data?.error ||
    err?.message ||
    'Azure OpenAI request failed'
  );
}

function buildPrompt(summary, description, crimType) {
  // Classification-only prompt (no effort calculation).
  // Effort/WBS should be computed deterministically in estimationEngine using your CRIM mapping + buildWbs().
  return `
You are a Senior IFS Technical Architect with extensive experience implementing
IFS Applications Cloud, IFS Aurena, IFS Integration Framework, Lobby, Reports,
Custom Objects, BPA, Interfaces, and Data Migration.

Your task is to classify ONLY the TECHNICAL COMPLEXITY of a Jira requirement.

INPUT CONTEXT
CRIM TYPE: ${crimType}
SUMMARY: ${summary}
DESCRIPTION: ${description}

COMPLEXITY SCALE (Choose ONE value only):
- Very Simple
- Simple
- Medium
- Complex
- Very Complex

STRICT OUTPUT FORMAT (JSON ONLY)
Return ONLY the following JSON — no additional text:

{
  "complexity": "Very Simple | Simple | Medium | Complex | Very Complex",
  "direction": "Inbound | Outbound | Bi-Directional | N/A",
  "flow": "Uni-Directional | Bi-Directional | N/A",
  "reason": "Short, professional, IFS-focused technical explanation"
}

IMPORTANT:
- DO NOT calculate effort
- DO NOT mention hours or days
- DO NOT suggest CRIM changes
`.trim();
}

/**
 * Azure OpenAI estimator (complexity + reasoning only).
 *
 * @param {string} summary
 * @param {string} description
 * @param {string|null} _modelIgnored (Azure uses deployment name)
 * @param {{crim_type?: string}} jiraMeta
 * @param {{endpoint?: string, apiKey?: string, deployment?: string, apiVersion?: string, timeoutMs?: number}} providerConfig
 * @returns {Promise<{ok: boolean, meta?: {complexity: string, direction?: string, flow?: string, reason: string}, error?: string, status?: number, detail?: any}>}
 */
async function azureEstimate(
  summary,
  description,
  _modelIgnored = null,
  jiraMeta = {},
  providerConfig = {}
) {
  // Prefer Settings config; fallback to env vars (as used in your project)
  let endpoint =
    safeTrim(providerConfig.endpoint) || safeTrim(process.env.AZURE_OPENAI_ENDPOINT);
  const apiKey =
    safeTrim(providerConfig.apiKey) || safeTrim(process.env.AZURE_OPENAI_KEY);
  const deployment =
    safeTrim(providerConfig.deployment) || safeTrim(process.env.AZURE_OPENAI_DEPLOYMENT);
  const apiVersion =
    safeTrim(providerConfig.apiVersion) ||
    safeTrim(process.env.AZURE_OPENAI_API_VERSION) ||
    DEFAULT_API_VERSION;

  const timeoutMs =
    Number(providerConfig.timeoutMs) > 0 ? Number(providerConfig.timeoutMs) : DEFAULT_TIMEOUT_MS;

  const crimType = safeTrim(jiraMeta?.crim_type) || 'Unknown';

  if (!endpoint || !apiKey || !deployment) {
    return {
      ok: false,
      error: 'Missing Azure OpenAI configuration (endpoint/apiKey/deployment).',
      detail: { hasEndpoint: !!endpoint, hasApiKey: !!apiKey, hasDeployment: !!deployment },
    };
  }

  endpoint = normalizeEndpoint(endpoint);

  const safeSummary = clampText(summary, MAX_TEXT_LEN);
  const safeDescription = clampText(description, MAX_TEXT_LEN);
  const prompt = buildPrompt(safeSummary, safeDescription, crimType);

  // Azure OpenAI deployment-based Chat Completions endpoint format (REST)
  const url =
    `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions` +
    `?api-version=${encodeURIComponent(apiVersion)}`;

  // Try strict JSON output (Azure supports it for compatible deployments/APIs).
  // If not supported, we still parse JSON from the text response.
  const payload = {
    temperature: 0.2,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  };

  const headers = {
    'Content-Type': 'application/json',
    'api-key': apiKey,
  };

  const maxAttempts = 3;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;

    try {
      const response = await axios.post(url, payload, { headers, timeout: timeoutMs });

      const content =
        response?.data?.choices?.[0]?.message?.content ??
        response?.data?.choices?.[0]?.text ??
        '';

      let parsed = null;

      // Parse JSON (preferred)
      try {
        parsed = typeof content === 'string' ? JSON.parse(content) : content;
      } catch (_) {
        // Fallback: extract JSON from noisy text
        const extracted = extractJsonObject(content);
        if (extracted) {
          try {
            parsed = JSON.parse(extracted);
          } catch (__) {
            parsed = null;
          }
        }
      }

      if (!parsed || typeof parsed !== 'object') {
        return {
          ok: false,
          error: 'Azure OpenAI returned invalid JSON output.',
          detail: { raw: content },
        };
      }

      const complexity = normalizeComplexity(parsed.complexity);
      const direction = safeTrim(parsed.direction) || 'N/A';
      const flow = safeTrim(parsed.flow) || 'N/A';
      const reason = safeTrim(parsed.reason) || safeTrim(parsed.reasoning) || '';

      return { ok: true, meta: { complexity, direction, flow, reason } };
    } catch (err) {
      const status = err?.response?.status;
      const msg = buildErrorMessage(err);

      const retryable =
        status ? isRetryableStatus(status) : /timeout|ECONNRESET|ETIMEDOUT/i.test(msg);

      if (!retryable || attempt >= maxAttempts) {
        return {
          ok: false,
          error: msg,
          status,
          detail: err?.response?.data || { message: msg },
        };
      }

      // Exponential backoff with jitter
      const backoff = Math.min(2000 * attempt, 8000);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(backoff + jitter);
    }
  }

  return { ok: false, error: 'Azure OpenAI request failed after retries.' };
}

module.exports = { azureEstimate };
