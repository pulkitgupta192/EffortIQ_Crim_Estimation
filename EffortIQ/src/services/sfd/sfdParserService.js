'use strict';
// src/services/sfd/sfdParserService.js
// =========================================================
// SFD Parser Service (FINAL – VERIFIED)
// =========================================================

const fs = require('fs');
const path = require('path');

function safeTrim(v) {
  return String(v ?? '').trim();
}

function extOf(filePath) {
  return path.extname(filePath).toLowerCase();
}

function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|tr)>/gi, '\n');
  s = s.replace(/<\/td>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return safeTrim(s);
}

async function parsePdf(filePath) {
  const pdfParse = require('pdf-parse');
  const buf = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  return {
    ok: true,
    text: safeTrim(data?.text),
    meta: { pages: data?.numpages || 0 },
  };
}

async function parseDocx(filePath) {
  const mammoth = require('mammoth');

  // 1) Raw text
  const raw = await mammoth.extractRawText({ path: filePath });
  if (safeTrim(raw?.value)) {
    return { ok: true, text: safeTrim(raw.value), meta: { mode: 'raw' } };
  }

  // 2) HTML fallback
  const htmlRes = await mammoth.convertToHtml({ path: filePath });
  const htmlText = safeTrim(htmlToText(htmlRes?.value));
  if (htmlText) {
    return { ok: true, text: htmlText, meta: { mode: 'html' } };
  }

  // 3) ✅ FINAL fallback: DOCX XML
  const xmlText = await parseDocxXmlFallback(filePath);
  if (safeTrim(xmlText)) {
    return { ok: true, text: xmlText, meta: { mode: 'xml' } };
  }

  // nothing worked
  return { ok: true, text: '', meta: { mode: 'empty' } };
}

async function parseDocxXmlFallback(filePath) {
  const unzipper = require('unzipper');

  const zip = await unzipper.Open.file(filePath);
  const docXml = zip.files.find(f => f.path === 'word/document.xml');

  if (!docXml) return '';

  const xml = await docXml.buffer();

  // Very safe XML → text extraction (no regex overreach)
  return String(xml)
    .replace(/<w:p[\s\S]*?>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function parseText(filePath) {
  return {
    ok: true,
    text: safeTrim(fs.readFileSync(filePath, 'utf8')),
    meta: { mode: 'text' },
  };
}

async function parseSfd(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        ok: false,
        error: 'SFD file not found',
        hint: 'Please select a valid file from disk',
      };
    }

    const ext = extOf(filePath);
    const fileName = path.basename(filePath);
    let res;

    if (ext === '.pdf') res = await parsePdf(filePath);
    else if (ext === '.docx') res = await parseDocx(filePath);
    else if (ext === '.txt' || ext === '.md') res = await parseText(filePath);
    else res = await parseText(filePath);

    const text = safeTrim(res?.text);

    if (!text) {
      return {
        ok: false,
        error: 'No extractable text found',
        hint:
          ext === '.pdf'
            ? 'This PDF is likely scanned. Please upload a DOCX or text-based PDF.'
            : 'Try saving the document as a plain DOCX or TXT.',
        meta: { fileName, ext },
      };
    }

    return {
      ok: true,
      text,
      meta: { fileName, ext, chars: text.length, ...(res.meta || {}) },
    };
  } catch (e) {
    return { ok: false, error: e.message || 'Failed to parse SFD' };
  }
}

module.exports = { parseSfd };