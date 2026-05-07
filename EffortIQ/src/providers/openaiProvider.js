'use strict';

// src/providers/openaiProvider.js
// =========================================================
// EffortIQ OpenAI Provider (Production-ready)
// - Uses Chat Completions endpoint
// - Enforces JSON-only output using response_format=json_object
// - Returns a stable contract used by estimationEngine
// - Supports runtime Settings config (providerConfig) + env fallback
// - Adds retry with exponential backoff for 429/5xx/timeouts
// =========================================================

const axios = require('axios');

const DEFAULT_MODEL = 'gpt-4o-mini';
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

/**
 * Extract a JSON object from arbitrary text (fallback).
 * Not normally needed when response_format=json_object works,
 * but kept for resilience.
 */
function extractJsonObject(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function buildPrompt(summary, description, crimType) {
  // Prompt aligned with your Forge logic: classify complexity only + reason/direction/flow
  // (No effort calculation here; effort is computed deterministically using CRIM mappings + WBS builder)
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

function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function buildErrorMessage(err) {
  return (
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.response?.data?.error ||
    err?.message ||
    'OpenAI request failed'
  );
}

/**
 * OpenAI estimate (complexity + reasoning only).
 *
 * @param {string} summary
 * @param {string} description
 * @param {string|null} model
 * @param {{crim_type?: string}} jiraMeta
 * @param {{apiKey?: string, model?: string, timeoutMs?: number, baseUrl?: string}} providerConfig
 * @returns {Promise<{ok: boolean, meta?: {complexity: string, direction?: string, flow?: string, reason: string}, error?: string, status?: number, detail?: any}>}
 */
async function openaiEstimate(
  summary,
  description,
  model = DEFAULT_MODEL,
  jiraMeta = {},
  providerConfig = {}
) {
  const apiKey =
    safeTrim(providerConfig.apiKey) || safeTrim(process.env.OPENAI_API_KEY);

  const useModel =
    safeTrim(providerConfig.model) || safeTrim(model) || DEFAULT_MODEL;

  const timeoutMs =
    Number(providerConfig.timeoutMs) > 0
      ? Number(providerConfig.timeoutMs)
      : DEFAULT_TIMEOUT_MS;

  const baseUrl = safeTrim(providerConfig.baseUrl) || 'https://api.openai.com';

  const crimType = safeTrim(jiraMeta?.crim_type) || 'Unknown';

  if (!apiKey) {
    return {
      ok: false,
      error:
        'Missing OpenAI API Key (set in Settings or via OPENAI_API_KEY env var)',
    };
  }

  const safeSummary = clampText(summary, MAX_TEXT_LEN);
  const safeDescription = clampText(description, MAX_TEXT_LEN);

  const prompt = buildPrompt(safeSummary, safeDescription, crimType);

  const payload = {
    model: useModel,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  };

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;

  // Retry policy
  const maxAttempts = 3;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;

    try {
      const response = await axios.post(url, payload, {
        headers,
        timeout: timeoutMs,
      });

      const content =
        response?.data?.choices?.[0]?.message?.content ??
        response?.data?.choices?.[0]?.text ??
        '';

      // With response_format=json_object, content should be valid JSON
      let parsed;
      try {
        parsed = typeof content === 'string' ? JSON.parse(content) : content;
      } catch (parseErr) {
        // Fallback extraction if upstream adds extra chars
        const extracted = extractJsonObject(content);
        if (extracted) {
          try {
            parsed = JSON.parse(extracted);
          } catch (_) {
            parsed = null;
          }
        }
      }

      if (!parsed || typeof parsed !== 'object') {
        return {
          ok: false,
          error: 'OpenAI returned invalid JSON output.',
          detail: { raw: content },
        };
      }

      const complexity = normalizeComplexity(parsed.complexity);
      const direction = safeTrim(parsed.direction) || 'N/A';
      const flow = safeTrim(parsed.flow) || 'N/A';
      const reason = safeTrim(parsed.reason) || safeTrim(parsed.reasoning) || '';

      return {
        ok: true,
        meta: {
          complexity,
          direction,
          flow,
          reason,
        },
      };
    } catch (err) {
      const status = err?.response?.status;
      const msg = buildErrorMessage(err);

      const retryable =
        status ? isRetryableStatus(status) : /timeout|ECONNRESET/i.test(msg);

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

  return { ok: false, error: 'OpenAI request failed after retries.' };
}

module.exports = { openaiEstimate };
