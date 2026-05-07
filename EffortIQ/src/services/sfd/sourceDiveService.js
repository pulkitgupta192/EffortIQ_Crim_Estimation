'use strict';
// src/services/sfd/sourceDiveService.js
// =========================================================
// Source Dive (FINAL)
// - Optional local indexing + simple file suggestion
// =========================================================

const fs = require('fs');
const path = require('path');

function safeTrim(v) {
  return String(v ?? '').trim();
}

function normalizePath(p) {
  return safeTrim(p).replace(/\\/g, '/'); // ✅ correct escape
}

function indexLocalSource(opts = {}) {
  const localDir = safeTrim(opts.localDir);
  if (!localDir) return { ok: false, error: 'localDir is required' };
  if (!fs.existsSync(localDir)) return { ok: false, error: `Directory not found: ${localDir}` };

  const maxFiles = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : 1200;
  const results = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build']);

  function walk(dir) {
    if (results.length >= maxFiles) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (results.length >= maxFiles) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        results.push({ path: normalizePath(full) });
      }
    }
  }

  walk(localDir);
  return { ok: true, total: results.length, files: results };
}

function suggestFilesForActivity(activity, sourceIndex) {
  const files = Array.isArray(sourceIndex?.files) ? sourceIndex.files : [];
  const needle = `${activity?.title ?? ''} ${activity?.description ?? ''}`.toLowerCase();
  const tokens = needle.split(/\W+/).filter(t => t.length >= 4);

  const scored = files
    .map(f => {
      const p = String(f.path ?? '').toLowerCase();
      let score = 0;
      for (const t of tokens) if (p.includes(t)) score += 1;
      return { path: f.path, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  return scored;
}

module.exports = { indexLocalSource, suggestFilesForActivity };
