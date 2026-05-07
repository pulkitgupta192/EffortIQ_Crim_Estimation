'use strict';
// src/services/sfd/llmClient.js
// ================================================= Minimal LLM Client for SFD workflows// =========================================================
// - Supports: openai, azure, gemini, local
// - Purpose: run custom prompts for SFD extraction/classification
// - Returns parsed JSON object (data)
// =========================================================

const axios = require('axios');

function safeTrim(v) {
  return String(v ?? '').trim();
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function postWithRetry(url, payload, headers, timeout = 60000, maxAttempts = 3) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const resp = await axios.post(url, payload, { headers, timeout });
      return { ok: true, resp };
    } catch (e) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.error?.message || e?.message || 'LLM call failed';
      const retryable = status ? isRetryableStatus(status) : /timeout|ECONNRESET|ETIMEDOUT/i.test(msg);

      if (!retryable || attempt >= maxAttempts) {
        return { ok: false, error: msg, status, detail: e?.response?.data };
      }

      const backoff = Math.min(1500 * attempt, 6000);
      await sleep(backoff + Math.floor(Math.random() * 250));
    }
  }
  return { ok: false, error: 'LLM call failed after retries' };
}

function parseJsonStrictOrExtract(text) {
  const raw = String(text ?? '');
  try {
    return JSON.parse(raw);
  } catch {
    const extracted = extractJsonObject(raw);
    if (!extracted) return null;
    try {
      return JSON.parse(extracted);
    } catch {
      return null;
    }
  }
}

async function callOpenAI(prompt, providerConfig = {}) {
  const apiKey = safeTrim(providerConfig.apiKey) || safeTrim(process.env.OPENAI_API_KEY);
  const model = safeTrim(providerConfig.model) || 'gpt-4o-mini';
  if (!apiKey) return { ok: false, error: 'Missing OpenAI apiKey' };

  const url = 'https://api.openai.com/v1/chat/completions';
  const payload = {
    model,
    temperature: 0.2,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  };

  const res = await postWithRetry(
    url,
    payload,
    { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    60000,
    3
  );

  if (!res.ok) return res;

  const content = res.resp?.data?.choices?.[0]?.message?.content || '';
  const parsed = parseJsonStrictOrExtract(content);
  if (!parsed) return { ok: false, error: 'OpenAI returned invalid JSON', detail: content };

  return { ok: true, data: parsed };
}

async function callAzure(prompt, providerConfig = {}) {
  const endpoint = safeTrim(providerConfig.endpoint) || safeTrim(process.env.AZURE_OPENAI_ENDPOINT);
  const apiKey = safeTrim(providerConfig.apiKey) || safeTrim(process.env.AZURE_OPENAI_KEY);
  const deployment = safeTrim(providerConfig.deployment) || safeTrim(process.env.AZURE_OPENAI_DEPLOYMENT);
  const apiVersion = safeTrim(providerConfig.apiVersion) || safeTrim(process.env.AZURE_OPENAI_API_VERSION) || '2024-06-01';

  if (!endpoint || !apiKey || !deployment) {
    return { ok: false, error: 'Missing Azure config (endpoint/apiKey/deployment)' };
  }

  const cleanEndpoint = endpoint.replace(/\/+$/, '');
  const url = `${cleanEndpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  const payload = {
    temperature: 0.2,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  };

  const res = await postWithRetry(
    url,
    payload,
    { 'Content-Type': 'application/json', 'api-key': apiKey },
    60000,
    3
  );

  if (!res.ok) return res;

  const content = res.resp?.data?.choices?.[0]?.message?.content || '';
  const parsed = parseJsonStrictOrExtract(content);
  if (!parsed) return { ok: false, error: 'Azure returned invalid JSON', detail: content };

  return { ok: true, data: parsed };
}

async function callGemini(prompt, providerConfig = {}) {
  const apiKey = safeTrim(providerConfig.apiKey) || safeTrim(process.env.GEMINI_API_KEY);
  const model = safeTrim(providerConfig.model) || 'gemini-1.5-pro';
  if (!apiKey) return { ok: false, error: 'Missing Gemini apiKey' };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1200 },
  };

  const res = await postWithRetry(
    url,
    payload,
    { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    60000,
    3
  );

  if (!res.ok) return res;

  const text = (res.resp?.data?.candidates?.[0]?.content?.parts || []).map(p => p.text).join('') || '';
  const parsed = parseJsonStrictOrExtract(text);
  if (!parsed) return { ok: false, error: 'Gemini returned invalid JSON', detail: text };

  return { ok: true, data: parsed };
}

async function callLocal(prompt, providerConfig = {}) {
  const endpoint =
    safeTrim(providerConfig.endpoint) ||
    safeTrim(process.env.LOCAL_ESTIMATE_ENDPOINT) ||
    'http://localhost:8080/estimate';

  const payload = { prompt };

  const res = await postWithRetry(
    endpoint,
    payload,
    { 'Content-Type': 'application/json' },
    60000,
    2
  );

  if (!res.ok) return res;

  const data = res.resp?.data;
  if (typeof data === 'object') return { ok: true, data };

  const text = String(data ?? '');
  const parsed = parseJsonStrictOrExtract(text);
  if (!parsed) return { ok: false, error: 'Local provider returned invalid JSON', detail: text };

  return { ok: true, data: parsed };
}

/**
 * Run a custom prompt against the chosen provider.
 * @param {'openai'|'azure'|'gemini'|'local'} provider
 * @param {string} prompt
 * @param {object} providerConfig
 */
async function runJsonPrompt(provider, prompt, providerConfig = {}) {
  const p = String(provider ?? 'openai').toLowerCase();
  if (p === 'azure') return callAzure(prompt, providerConfig);
  if (p === 'gemini') return callGemini(prompt, providerConfig);
  if (p === 'local') return callLocal(prompt, providerConfig);
  return callOpenAI(prompt, providerConfig);
}

module.exports = { runJsonPrompt };
