/**
 * src/constants/CAMELOT_WHEEL.js
 *
 * Conversione tra notazione musicale standard ("C major", "A minor")
 * e notazione Camelot Wheel usata da DJ + Rekordbox ("8B", "8A").
 *
 * La ruota Camelot permette di mixare in armonia: tracce con codici
 * adiacenti (8B↔9B, 8B↔7B) o relativi (8B↔8A) suonano bene insieme.
 *
 * Esporta: CAMELOT_WHEEL, KEY_ALIASES, toCamelot, fromCamelot, normalizeKey
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────
// Tabella ufficiale (12 maggiori + 12 minori)
// ─────────────────────────────────────────────────────────────────────
const CAMELOT_WHEEL = Object.freeze({
  // Major (B side)
  'C major':  '8B',
  'G major':  '9B',
  'D major':  '10B',
  'A major':  '11B',
  'E major':  '12B',
  'B major':  '1B',
  'F# major': '2B',
  'C# major': '3B',
  'G# major': '4B',
  'D# major': '5B',
  'A# major': '6B',
  'F major':  '7B',
  // Minor (A side)
  'A minor':  '8A',
  'E minor':  '9A',
  'B minor':  '10A',
  'F# minor': '11A',
  'C# minor': '12A',
  'G# minor': '1A',
  'D# minor': '2A',
  'A# minor': '3A',
  'F minor':  '4A',
  'C minor':  '5A',
  'G minor':  '6A',
  'D minor':  '7A',
});

// ─────────────────────────────────────────────────────────────────────
// Alias: equivalenze enarmoniche (Db = C#, ecc.)
// Essentia spesso ritorna Db invece di C#, dobbiamo normalizzare.
// ─────────────────────────────────────────────────────────────────────
const KEY_ALIASES = Object.freeze({
  'Db': 'C#', 'D♭': 'C#',
  'Eb': 'D#', 'E♭': 'D#',
  'Gb': 'F#', 'G♭': 'F#',
  'Ab': 'G#', 'A♭': 'G#',
  'Bb': 'A#', 'B♭': 'A#',
  // varianti ASCII da fonti che usano "b" minuscolo per bemolle
  'db': 'C#', 'eb': 'D#', 'gb': 'F#', 'ab': 'G#', 'bb': 'A#',
});

// ─────────────────────────────────────────────────────────────────────
// normalizeKey('Db') → 'C#'  ; normalizeKey('C#m') → 'C#'
// Restituisce solo la nota (senza scala).
// ─────────────────────────────────────────────────────────────────────
function normalizeKey(rawKey) {
  if (!rawKey) return null;
  let s = String(rawKey).trim();
  // Rimuove suffissi tipo "m"/"minor"/"M"/"major" da fine stringa
  s = s.replace(/\s*(maj(or)?|min(or)?|M|m)\s*$/i, '').trim();
  // Sostituisce ♭ con b
  s = s.replace(/♭/g, 'b').replace(/♯/g, '#');
  // Capitalizza prima lettera, mantiene #/b
  if (s.length >= 1) {
    s = s.charAt(0).toUpperCase() + s.slice(1);
  }
  // Lookup alias
  if (KEY_ALIASES[s]) return KEY_ALIASES[s];
  return s;
}

function normalizeScale(rawScale) {
  if (!rawScale) return null;
  const s = String(rawScale).trim().toLowerCase();
  if (/^maj/.test(s)) return 'major';
  if (/^min/.test(s)) return 'minor';
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// toCamelot({ key, scale }) → '8B' | null
// ─────────────────────────────────────────────────────────────────────
function toCamelot({ key, scale } = {}) {
  const k = normalizeKey(key);
  const s = normalizeScale(scale);
  if (!k || !s) return null;
  const canonical = `${k} ${s}`;
  return CAMELOT_WHEEL[canonical] || null;
}

// ─────────────────────────────────────────────────────────────────────
// fromCamelot('8B') → { key:'C', scale:'major' } | null
// ─────────────────────────────────────────────────────────────────────
const _REVERSE = (() => {
  const m = {};
  for (const [k, v] of Object.entries(CAMELOT_WHEEL)) m[v] = k;
  return Object.freeze(m);
})();

function fromCamelot(code) {
  if (!code) return null;
  const norm = String(code).trim().toUpperCase();
  const canonical = _REVERSE[norm];
  if (!canonical) return null;
  const [key, scale] = canonical.split(' ');
  return { key, scale };
}

module.exports = {
  CAMELOT_WHEEL,
  KEY_ALIASES,
  normalizeKey,
  normalizeScale,
  toCamelot,
  fromCamelot,
};
