'use strict';
// src/services/sfd/activityDeduper.js
// =========================================================
// Activity de-duplication
// - Normalizes activity titles/descriptions to avoid double counting
// =========================================================

function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(['the','a','an','to','of','and','or','in','on','for','with','by','from','is','are','be','as','at','this','that','it','will','shall','must','should']);

function fingerprint(activity) {
  const title = norm(activity?.title || activity?.name || '');
  const desc = norm(activity?.description || '');
  const raw = (title + ' ' + desc).split(' ').filter(w => w && !STOP.has(w));
  // keep first 14 meaningful tokens to form a stable key
  return raw.slice(0, 14).join(' ');
}

function dedupeActivities(activities = []) {
  const map = new Map();
  const duplicates = [];

  for (const a of (Array.isArray(activities) ? activities : [])) {
    const key = fingerprint(a);
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, a);
    } else {
      duplicates.push({ duplicate: a, of: map.get(key) });
    }
  }

  return {
    unique: Array.from(map.values()),
    duplicates,
  };
}

module.exports = { dedupeActivities, fingerprint };
