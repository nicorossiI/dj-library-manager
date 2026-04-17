/**
 * src/utils/bpmUtils.js
 *
 * Utility BPM: dato un valore BPM ritorna i generi compatibili secondo
 * GENRE_RULES.BPM_RANGES. Include half-time/double-time normalization.
 *
 * Esporta: bpmToGenreHints, normalizeBpm
 * Dipendenze: GENRE_RULES
 */

'use strict';

const { GENRE_RULES } = require('../constants/GENRE_RULES');

/**
 * Normalizza un BPM "strano" (es. 70 che in realtà è 140 half-time, o 170 che è 85 doubled).
 * Ritorna il BPM originale; i calling site decidono se usare normalizzazione.
 * min/max default 70..200.
 */
function normalizeBpm(bpm, { min = 70, max = 200 } = {}) {
  if (!bpm || !Number.isFinite(bpm)) return null;
  let b = Number(bpm);
  while (b < min) b *= 2;
  while (b > max) b /= 2;
  return Math.round(b * 10) / 10;
}

function bpmToGenreHints(bpm, { tolerance = 2 } = {}) {
  if (!bpm || !Number.isFinite(bpm)) return [];
  const hits = [];
  for (const [genre, range] of Object.entries(GENRE_RULES.BPM_RANGES)) {
    if (bpm >= range.min - tolerance && bpm <= range.max + tolerance) {
      const mid = (range.min + range.max) / 2;
      const dist = Math.abs(bpm - mid);
      hits.push({ genre, distance: dist });
    }
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits.map(h => h.genre);
}

module.exports = { bpmToGenreHints, normalizeBpm };
