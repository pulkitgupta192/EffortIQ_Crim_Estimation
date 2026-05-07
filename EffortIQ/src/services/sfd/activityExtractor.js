'use strict';
// src/services/sfd/activityExtractor.js
// =========================================================
// Activity Extraction (Heuristic v2 - Context + CRIM aware)
// - Parses SFD plain text and extracts implementable development activities
// - Includes Acceptance Criteria / Test Case sections (as requested)
// - Produces: { title, description, subtypeHint, confidence, evidence{sectionPath, quote}, signals }
// =========================================================

const crypto = require('crypto');
const { looksActionable, inferSubtype } = require('./activityRules.js'); // reuse your rules [2](https://be4you-my.sharepoint.com/personal/pulkit_gupta_bearingpoint_com/Documents/Microsoft%20Copilot%20Chat%20Files/activityRules.js)
const { dedupeActivities } = require('./activityDeduper.js');            // your deduper [9](https://be4you-my.sharepoint.com/personal/pulkit_gupta_bearingpoint_com/Documents/Microsoft%20Copilot%20Chat%20Files/activityEstimationEngine.js)
const { ALLOWED_SUBTYPES } = require('./activityMatrix.js');             // keep subtype hints within matrix [3](https://be4you-my.sharepoint.com/personal/pulkit_gupta_bearingpoint_com/Documents/Microsoft%20Copilot%20Chat%20Files/activityMatrix.js)

function sha1(s) {
  return crypto.createHash('sha1').update(String(s ?? ''), 'utf8').digest('hex');
}
function safeTrim(v) { return String(v ?? '').trim(); }

function normalizeNewlines(text) {
  return safeTrim(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function compact(s, max = 240) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Section classification
 * - IN_SCOPE_REQUIREMENTS: likely implementable requirements
 * - ACCEPTANCE: test cases / acceptance criteria (included by request, lower weight)
 * - OUT_OF_SCOPE: glossary/revision/TOC/etc.
 */
function classifySectionTitle(title) {
  const t = String(title ?? '').toLowerCase();

  // explicit OUT OF SCOPE
  if (
    t.includes('revision history') ||
    t.includes('distribution') ||
    t.includes('glossary') ||
    t.includes('table of contents') ||
    t === 'contents'
  ) return 'OUT_OF_SCOPE';

  // acceptance / tests - INCLUDED (user requirement)
  if (
    t.includes('acceptance') ||
    t.includes('approval criteria') ||
    t.includes('test case') ||
    t.includes('test cases') ||
    t.includes('validation')
  ) return 'ACCEPTANCE';

  // in-scope requirement heavy sections
  if (
    t.includes('functional specification') ||
    t.includes('functional specifications') ||
    t.includes('process') ||
    t.includes('field description') ||
    t.includes('layout') ||
    t.includes('business rule') ||
    t.includes('other rules') ||
    t.includes('dependencies') ||
    t.includes('interface') ||
    t.includes('report') ||
    t.includes('configuration')
  ) return 'IN_SCOPE_REQUIREMENTS';

  // default: treat as in-scope but with lower weight (keeps recall high)
  return 'IN_SCOPE_REQUIREMENTS';
}

/**
 * Heading detection:
 * matches patterns like:
 *  "2 Functional specifications ..."
 *  "2.5 Process description"
 */
function parseHeading(line) {
  const s = safeTrim(line);
  // e.g. "2.5 Process description"
  const m = s.match(/^(\d+(?:\.\d+)*)\s+(.{3,})$/);
  if (!m) return null;

  const num = m[1];
  const title = m[2].trim();
  // reject if it looks like a normal sentence
  if (title.length < 3) return null;
  // reject if heading is too long (likely a bullet)
  if (title.length > 140) return null;

  const level = num.split('.').length;
  return { num, title, level };
}

function isNoiseLine(line) {
  const s = safeTrim(line);
  if (!s) return true;
  if (s.length < 10) return true;
  if (/^\d+\s*$/.test(s)) return true;
  if (/^page\s+\d+\s+of\s+\d+$/i.test(s)) return true;
  if (/^(table of contents|contents)$/i.test(s)) return true;
  // excessive punctuation-only lines
  if (/^[\-=*_•\s]{6,}$/.test(s)) return true;
  return false;
}

/**
 * Bullet / list line detection
 */
function isBullet(line) {
  const s = safeTrim(line);
  return /^(\-|\*|•|–|—)\s+/.test(s) || /^\d+[\.\)]\s+/.test(s);
}

function stripBulletPrefix(line) {
  return String(line ?? '')
    .replace(/^(\-|\*|•|–|—)\s+/, '')
    .replace(/^\d+[\.\)]\s+/, '')
    .trim();
}

/**
 * Signals (IFS/CRIM)
 * We use these to increase precision: activities referencing real IFS artifacts are more likely implementable.
 * Based on IFS documentation about Aurena/Projections, REST/OData, workflows etc. [5](https://docs.ifs.com/techdocs/23r2/060_development/022_user_interface/030_aurena_dev/100_how_to_develop_aurena_pages/010_getting_started/)[6](https://docs.ifs.com/techdocs/23r2/040_tailoring/300_extensibility/600_integration/040_rest_apis/010_inbound_rest/)
 */
function extractSignals(text) {
  const s = String(text ?? '').toLowerCase();

  const has = (re) => re.test(s);

  const signals = {
    // UI / Aurena
    ui: has(/\b(aurena|page|screen|tab|assistant|lobby|page designer|navigation|command)\b/),
    // Projections / service layer
    projection: has(/\b(projection|entityset|entity set|action|function|structure|virtual|summary|plsvc|override|overtake)\b/),
    // Workflows
    workflow: has(/\b(bpa|workflow|approval|routing|process enrichment|camunda)\b/),
    // Integration
    integration: has(/\b(rest|odata|api|endpoint|inbound|outbound|bi-directional|interface|soap|import|export)\b/),
    // Reporting
    reporting: has(/\b(report|quick report|crystal|report designer|ssrs|report studio)\b/),
    // Data / migration
    data: has(/\b(migration|etl|script|sql|data load|batch)\b/),

    // config intent (Solution Manager, projection config etc.) [8](https://docs.ifs.com/techdocs/Foundation1/045_administration_aurena/220_Configuration/300_projection_configurations/default.htm)
    configuration: has(/\b(configuration|configure|solution manager|manage projections|projection configuration)\b/),

    // calculations / validations
    rules: has(/\b(validate|validation|calculate|calculation|default|mandatory|prefill|derived)\b/),
  };

  return signals;
}

/**
 * Penalize vague statements unless they contain concrete IFS artifacts or data/field references.
 */
function isVague(text) {
  const s = String(text ?? '').toLowerCase();
  const vagueWords = /\b(ensure|improve|optimize|support|facilitate|streamline|enhance)\b/;
  const concrete = /\b(field|dropdown|lov|projection|aurena|workflow|bpa|report|interface|api|odata|migration)\b/;
  return vagueWords.test(s) && !concrete.test(s);
}

/**
 * Score candidate:
 * - actionability: uses your looksActionable() [2](https://be4you-my.sharepoint.com/personal/pulkit_gupta_bearingpoint_com/Documents/Microsoft%20Copilot%20Chat%20Files/activityRules.js)
 * - implementability: IFS/CRIM signals
 * - section weight: acceptance included but lower
 */
function scoreCandidate(text, sectionClass) {
  const s = String(text ?? '').trim();
  const signals = extractSignals(s);

  let score = 0;

  // actionability
  if (looksActionable(s)) score += 0.45;     // strong base signal [2](https://be4you-my.sharepoint.com/personal/pulkit_gupta_bearingpoint_com/Documents/Microsoft%20Copilot%20Chat%20Files/activityRules.js)
  if (isBullet(s)) score += 0.10;

  // implementability signals
  if (signals.ui) score += 0.12;
  if (signals.projection) score += 0.12;
  if (signals.workflow) score += 0.12;
  if (signals.integration) score += 0.12;
  if (signals.reporting) score += 0.10;
  if (signals.data) score += 0.10;
  if (signals.rules) score += 0.08;
  if (signals.configuration) score += 0.10;

  // section weighting
  if (sectionClass === 'IN_SCOPE_REQUIREMENTS') score += 0.10;
  if (sectionClass === 'ACCEPTANCE') score -= 0.05;  // still included, but slightly lower
  if (sectionClass === 'OUT_OF_SCOPE') score -= 0.60;

  // vague penalty
  if (isVague(s)) score -= 0.25;

  // length sanity (too short often vague)
  if (s.length < 25) score -= 0.10;

  // clamp
  score = Math.max(0, Math.min(1, score));
  return { score, signals };
}

/**
 * Split complex sentences into atomic activities.
 * - split on ';'
 * - split on ' and ' only if it looks like multiple verbs/actions
 */
function splitAtomic(text) {
  const s = String(text ?? '').trim();
  if (!s) return [];

  // first split on semicolons
  const semiParts = s.split(/;\s+/).map(x => x.trim()).filter(Boolean);

  const out = [];
  for (const part of semiParts) {
    // if multiple actions joined by " and " and contains verb markers, split
    const lower = part.toLowerCase();
    const verbish = /\b(add|create|update|modify|configure|implement|enable|disable|validate|calculate|integrate|import|export|deploy|design)\b/;
    if (lower.includes(' and ') && verbish.test(lower)) {
      const andParts = part.split(/\s+and\s+/i).map(x => x.trim()).filter(Boolean);
      // keep only if split makes sense
      if (andParts.length >= 2) out.push(...andParts);
      else out.push(part);
    } else {
      out.push(part);
    }
  }

  return out;
}

/**
 * Subtype hint:
 * - primary from your inferSubtype() rules [2](https://be4you-my.sharepoint.com/personal/pulkit_gupta_bearingpoint_com/Documents/Microsoft%20Copilot%20Chat%20Files/activityRules.js)
 * - additional config hints mapped into existing allowed subtypes [3](https://be4you-my.sharepoint.com/personal/pulkit_gupta_bearingpoint_com/Documents/Microsoft%20Copilot%20Chat%20Files/activityMatrix.js)
 */
function inferSubtypeHint(text) {
  const ruleHint = inferSubtype(text);
  if (ruleHint && ALLOWED_SUBTYPES.has(ruleHint)) return ruleHint;

  const s = String(text ?? '').toLowerCase();

  // Configuration mapping (we keep within allowed set)
  // - projection config / manage projections => CU_OB
  if (/\b(projection configuration|manage projections|projection)\b/.test(s)) return 'CU_OB';
  // - page designer / layout / screen config => CU_PA
  if (/\b(page designer|layout|screen|page|tab|aurena)\b/.test(s)) return 'CU_PA';

  // Integration
  if (/\b(inbound|consume|import)\b/.test(s)) return 'IN_IN';
  if (/\b(outbound|export)\b/.test(s)) return 'IN_OU';
  if (/\b(rest|odata|api|endpoint)\b/.test(s)) return 'IN_AP';

  // Reports
  if (/\b(quick report|qr)\b/.test(s)) return 'RE_QR';
  if (/\b(business report|br|report)\b/.test(s)) return 'RE_BR';

  // BPA / workflow
  if (/\b(bpa|workflow|approval|routing|process enrichment)\b/.test(s)) return 'CU_BP';

  // Modifications
  if (/\b(plsql|voucher_row_api|row_api|posting|business logic)\b/.test(s)) return 'MO_FL';
  if (/\b(screen modification|modify screen)\b/.test(s)) return 'MO_SC';

  // Data migration
  if (/\b(migration task)\b/.test(s)) return 'DM_MT';
  if (/\b(migration script|sql script|etl)\b/.test(s)) return 'DM_SC';

  return null;
}

function makeId(idx, title) {
  return `ACT-${idx}-${sha1(title).slice(0, 8)}`;
}

function buildActivity({ sentence, sectionPath, sectionClass, score, signals }, idx) {
  const clean = stripBulletPrefix(sentence);
  const title = compact(clean, 140);
  const description = compact(clean, 700);
  const subtypeHint = inferSubtypeHint(clean);

  return {
    id: makeId(idx, title),
    title,
    description,
    subtypeHint,
    confidence: score,
    evidence: {
      sectionPath,
      quote: compact(sentence, 900),
      sectionClass,
    },
    signals,
    source: { kind: 'heuristic-v2', evidence: sentence },
  };
}

/**
 * Main API
 * - Includes Acceptance Criteria/Test Case sections
 * - options:
 *    maxActivities (default 250)
 *    minConfidence (default 0.55)
 *    includeAcceptance (default true)  // per your requirement
 */
function extractActivitiesHeuristic(text, options = {}) {
  const maxActivities = Number(options.maxActivities) > 0 ? Number(options.maxActivities) : 250;
  const minConfidence = Number(options.minConfidence) >= 0 ? Number(options.minConfidence) : 0.55;
  const includeAcceptance = options.includeAcceptance !== false; // default true

  const lines = normalizeNewlines(text).split('\n').map(l => l.trim()).filter(Boolean);

  // heading stack
  const stack = [];
  let currentSectionTitle = 'Document';
  let currentSectionClass = 'IN_SCOPE_REQUIREMENTS';

  // collected candidates (pre-dedupe)
  const candidates = [];
  let rawCount = 0;

  // helper to build section path
  const sectionPath = () => {
    if (!stack.length) return currentSectionTitle || 'Document';
    const parts = stack.map(x => `${x.num} ${x.title}`);
    return parts.join(' > ');
  };

  for (const line0 of lines) {
    const line = safeTrim(line0);
    if (isNoiseLine(line)) continue;

    // update section stack
    const h = parseHeading(line);
    if (h) {
      // adjust stack by level
      while (stack.length >= h.level) stack.pop();
      stack.push(h);

      currentSectionTitle = `${h.num} ${h.title}`;
      currentSectionClass = classifySectionTitle(h.title);
      continue;
    }

    // skip out-of-scope sections
    if (currentSectionClass === 'OUT_OF_SCOPE') continue;
    if (currentSectionClass === 'ACCEPTANCE' && !includeAcceptance) continue;

    // decide if line is a candidate statement
    const normalized = stripBulletPrefix(line);

    // Candidates: bullets OR actionable lines OR lines with strong IFS signals
    const { score, signals } = scoreCandidate(line, currentSectionClass);

    const strongSignal =
      signals.ui || signals.projection || signals.workflow || signals.integration ||
      signals.reporting || signals.data || signals.configuration;

    const shouldConsider =
      isBullet(line) || looksActionable(normalized) || strongSignal;

    if (!shouldConsider) continue;

    rawCount += 1;

    // split to atomic tasks and score each part (keeps precision)
    const atomicParts = splitAtomic(normalized);
    for (const part of atomicParts) {
      if (candidates.length >= maxActivities) break;

      const partScoreObj = scoreCandidate(part, currentSectionClass);
      const finalScore = partScoreObj.score;

      // keep if above threshold OR in acceptance section but still meaningful
      if (finalScore >= minConfidence) {
        candidates.push({
          sentence: part,
          sectionPath: sectionPath(),
          sectionClass: currentSectionClass,
          score: finalScore,
          signals: partScoreObj.signals,
        });
      }
    }

    if (candidates.length >= maxActivities) break;
  }

  // build activities
  const built = candidates.map((c, i) => buildActivity(c, i + 1));

  // dedupe
  const { unique, duplicates } = dedupeActivities(built);

  // stats
  const acceptanceCount = unique.filter(a => a?.evidence?.sectionClass === 'ACCEPTANCE').length;
  const needsReview = unique.filter(a => a.confidence < 0.70).length;

  return {
    ok: true,
    activities: unique,
    meta: {
      linesScanned: lines.length,
      candidatesSeen: rawCount,
      extracted: built.length,
      unique: unique.length,
      duplicates: duplicates.length,
      acceptanceIncluded: Boolean(includeAcceptance),
      acceptanceCount,
      minConfidence,
      needsReview,
    },
    duplicates,
  };
}

module.exports = { extractActivitiesHeuristic };