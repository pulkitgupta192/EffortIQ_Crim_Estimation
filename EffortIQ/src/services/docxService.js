'use strict';
// src/services/docxService.js
// =========================================================
// EffortIQ - DOCX Service
// - Extracts raw text from a .docx SFD document
// - Uses mammoth (docx -> clean text)
// =========================================================
const mammoth = require('mammoth');

function safeTrim(v) {
  return String(v ?? '').trim();
}

function isDocx(p) {
  const s = safeTrim(p).toLowerCase();
  return s.endsWith('.docx');
}

const docxService = {
  /**
   * Extract raw text from a DOCX file.
   * @param {string} filePath
   * @returns {Promise<{ok:boolean, text?:string, stats?:{chars:number, lines:number}, error?:string}>}
   */
  async extractRawText(filePath) {
    try {
      if (!filePath || typeof filePath !== 'string') {
        return { ok: false, error: 'Invalid filePath' };
      }
      if (!isDocx(filePath)) {
        return { ok: false, error: 'Only .docx files are supported for SFD estimation' };
      }

      // ✅ IMPORTANT: pass path to Mammoth
      const result = await mammoth.extractRawText({ path: filePath });

      const text = safeTrim(result?.value);
      const lines = text ? text.split(/\r?\n/).filter(Boolean).length : 0;
      const chars = text.length;

      return { ok: true, text, stats: { chars, lines } };
    } catch (e) {
      return { ok: false, error: e?.message || 'DOCX parsing failed' };
    }
  },
};

module.exports = { docxService };