'use strict';
// src/services/sfd/activityRules.js
// =========================================================
// Rule-based helpers for extraction + subtype inference (FINAL)
// =========================================================

const { ALLOWED_SUBTYPES } = require('./activityMatrix.js');

const ACTION_VERBS = [
  'add','create','update','modify','change','remove','delete','configure','implement',
  'enable','disable','validate','migrate','import','export','integrate','map','design',
  'deploy','test','document','refactor','extend','fix'
];

const KEYWORD_TO_SUBTYPE = [
  { re: /\b(custom object|projection|logical unit|\blu\b)\b/i, subtype: 'CU_OB' },
  { re: /\b(screen|page|tab|aurena|field|layout|ui|lobby)\b/i, subtype: 'CU_PA' },
  { re: /\b(event|action|command)\b/i, subtype: 'CU_EV' },
  { re: /\b(bpa|workflow|process|approval|routing)\b/i, subtype: 'CU_BP' },
  { re: /\b(lobby)\b/i, subtype: 'CU_LO' },
  { re: /\b(business report|\bbr\b|report)\b/i, subtype: 'RE_BR' },
  { re: /\b(quick report|\bqr\b)\b/i, subtype: 'RE_QR' },
  { re: /\b(inbound interface|interface\s*\(in\)|consume api|import)\b/i, subtype: 'IN_IN' },
  { re: /\b(outbound interface|interface\s*\(out\)|export)\b/i, subtype: 'IN_OU' },
  { re: /\b(rest api|api endpoint|integration api|soap)\b/i, subtype: 'IN_AP' },
  { re: /\b(armony data)\b/i, subtype: 'IN_AD' },
  { re: /\b(modification flux|posting|business logic|api package|voucher_row_api|row_api|plsql)\b/i, subtype: 'MO_FL' },
  { re: /\b(modification screen|screen modification)\b/i, subtype: 'MO_SC' },
  { re: /\b(forms armony)\b/i, subtype: 'FO_AR' },
  { re: /\b(crystal report)\b/i, subtype: 'FO_CR' },
  { re: /\b(report designer)\b/i, subtype: 'FO_RD' },
  { re: /\b(data migration|migration task)\b/i, subtype: 'DM_MT' },
  { re: /\b(migration script|sql script|etl)\b/i, subtype: 'DM_SC' },
];

function inferSubtype(text) {
  const s = String(text ?? '');
  for (const rule of KEYWORD_TO_SUBTYPE) {
    if (rule.re.test(s) && ALLOWED_SUBTYPES.has(rule.subtype)) return rule.subtype;
  }
  return null;
}

function looksActionable(line) {
  const s = String(line ?? '').trim();
  if (s.length < 12) return false;
  const lower = s.toLowerCase();

  if (/\b(shall|must|should|need to|required to|requires)\b/i.test(lower)) return true;

  const first = lower.split(/\s+/)[0];
  if (ACTION_VERBS.includes(first)) return true;

  return ACTION_VERBS.some(v => lower.includes(` ${v} `));
}

module.exports = { ACTION_VERBS, KEYWORD_TO_SUBTYPE, inferSubtype, looksActionable };
