/**
 * src/utils/languageUtils.js
 *
 * Rilevamento lingua vocals a CASCATA (spec utente + fix strumentali).
 *
 * REGOLE CRITICHE:
 *  - "instrumental" solo con KEYWORD ESPLICITA nel nome (instrumental, karaoke,
 *    acapella, beat only, no vocal). Lingua unknown ≠ instrumental.
 *  - Default quando nulla è determinabile: "mixed" (NON "instrumental").
 *
 * Cascata:
 *   1. Instrumental keyword esplicita      → "instrumental"
 *   2. Path segments (italiano/spanish...) → "it"|"es"|"en"
 *   3. ARTIST_LANG_HINTS su filename/title/artist → lang
 *   4. Word-count particles                 → "it"|"es"|"mixed"
 *   5. franc-min su title+artist            → ISO 2-letter
 *   6. Default                              → "mixed"
 *
 * Output: "es"|"it"|"en"|"fr"|"pt"|"de"|"nl"|"mixed"|"instrumental"
 */

'use strict';

// franc-min v5 CJS / v6+ ESM compat
const francMod = require('franc-min');
const franc = (typeof francMod === 'function')
  ? francMod
  : (francMod.franc || francMod.default || (() => 'und'));

const { GENRE_RULES } = require('../constants/GENRE_RULES');

const ISO_MAP = {
  ita: 'it', eng: 'en', spa: 'es', fra: 'fr',
  por: 'pt', deu: 'de', nld: 'nl',
};

// ─────────────────────────────────────────────────────────────────────
// Instrumental hint SOLO con keyword esplicita
// ─────────────────────────────────────────────────────────────────────

function hasInstrumentalHint(text = '') {
  if (!text) return false;
  const low = String(text).toLowerCase();
  const kws = GENRE_RULES.INSTRUMENTAL_KEYWORDS || [];
  // Check parole chiave esatte (anche con confini parola/parentesi)
  for (const kw of kws) {
    if (low.includes(kw)) return true;
  }
  // Pattern aggiuntivi (parentesi con "inst.")
  if (/\binstrumental\b|\(inst\.?\)|\[inst\.?\]|karaoke|\bacapella\b|\bacappella\b/i.test(low)) {
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Path-based hint
// ─────────────────────────────────────────────────────────────────────
const PATH_LANG_HINTS = [
  [/italiano\s+spagnolo|spagnolo\s+italiano/i, 'mixed'],
  [/italiano|italian/i, 'it'],
  [/spanish|spagnol/i, 'es'],
  [/english|inglese|ingles/i, 'en'],
  [/french|francese/i, 'fr'],
  [/portuguese|portoghese|portugu[eè]s/i, 'pt'],
];

function detectLanguageFromPath(filePath = '') {
  if (!filePath) return '';
  const s = String(filePath);
  for (const [re, lang] of PATH_LANG_HINTS) {
    if (re.test(s)) return lang;
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────
// Artist → language lookup (ARTIST_LANG_HINTS)
// Cerca substring dei nomi nel testo (filename/title/artist combinati).
// ─────────────────────────────────────────────────────────────────────

function detectLanguageFromArtist(text = '') {
  if (!text) return '';
  const low = String(text).toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
  const hints = GENRE_RULES.ARTIST_LANG_HINTS || {};
  const foundLangs = new Set();
  const foundES = [];
  const foundIT = [];
  for (const [artistKey, lang] of Object.entries(hints)) {
    if (low.includes(artistKey)) {
      foundLangs.add(lang);
      if (lang === 'es') foundES.push(artistKey);
      if (lang === 'it') foundIT.push(artistKey);
    }
  }
  if (foundLangs.size === 0) return '';
  if (foundLangs.size === 1) return [...foundLangs][0];
  // Combinazione specifica IT + ES → "it_es" (cartella dedicata "IT x ES Vocals")
  if (foundIT.length > 0 && foundES.length > 0 && foundLangs.size === 2) {
    return 'it_es';
  }
  // Mix generico (≥3 lingue diverse, o IT+EN, ES+EN, ecc.) → "mixed"
  return 'mixed';
}

// ─────────────────────────────────────────────────────────────────────
// Particle-count
// ─────────────────────────────────────────────────────────────────────
const ES_PARTICLES = new Set([
  'de', 'la', 'el', 'te', 'mi', 'tu', 'que', 'con', 'para', 'una',
  'yo', 'no', 'si', 'como', 'todo', 'por', 'lo', 'los', 'las',
  'un', 'es', 'se', 'me', 'su', 'al', 'nos', 'ella', 'ellos',
  'nada', 'todos', 'esto', 'eso',
]);

const IT_PARTICLES = new Set([
  'della', 'del', 'che', 'non', 'per', 'una', 'sono', 'nella',
  'questo', 'come', 'tutto', 'dello', 'degli', 'delle',
  'sul', 'sulla', 'nel', 'negli', 'alla', 'con', 'senza',
  'mio', 'mia', 'tuo', 'tua', 'suo', 'sua', 'ancora', 'sempre',
]);

function countParticles(text, dict) {
  if (!text) return 0;
  const tokens = String(text).toLowerCase().split(/[^a-zàèéìòù]+/i).filter(Boolean);
  let n = 0;
  for (const t of tokens) if (dict.has(t)) n++;
  return n;
}

function detectLanguageFromParticles(text) {
  if (!text) return '';
  const es = countParticles(text, ES_PARTICLES);
  const it = countParticles(text, IT_PARTICLES);
  if (es >= 2 && es > it) return 'es';
  if (it >= 2 && it > es) return 'it';
  if (es >= 2 && it >= 2 && Math.abs(es - it) <= 1) return 'mixed';
  return '';
}

// ─────────────────────────────────────────────────────────────────────
// Main detector (testo libero) — usato come fallback 5
// ─────────────────────────────────────────────────────────────────────

function detectLanguage(text = '', { minLen = 8 } = {}) {
  if (!text) return '';
  const t = String(text).trim();
  if (t.length < minLen) return '';
  const code = franc(t, { minLength: minLen });
  if (!code || code === 'und') return '';
  return ISO_MAP[code] || '';
}

// ─────────────────────────────────────────────────────────────────────
// detectFromTrack — cascata completa (spec aggiornata)
// ─────────────────────────────────────────────────────────────────────

function detectFromTrack(track) {
  if (!track) return 'mixed';

  const title = track.localTitle || track.title || '';
  const artist = track.localArtist || track.artist || '';
  const fileName = track.fileName || '';
  const filePath = track.filePath || '';
  const recognizedArtist = track.recognizedArtist || '';
  const recognizedTitle = track.recognizedTitle || '';

  // Testo combinato per la detection (filename + title + artist)
  const comboText = `${fileName} ${title} ${artist} ${recognizedTitle} ${recognizedArtist}`;

  // 1. Instrumental SOLO con keyword esplicita
  if (hasInstrumentalHint(comboText)) return 'instrumental';

  // 2. Path segments (italiano/spanish/ecc.)
  const pathLang = detectLanguageFromPath(filePath);
  if (pathLang) return pathLang;

  // 3. Artist → lang via ARTIST_LANG_HINTS (filename + artist fields)
  const artistLang = detectLanguageFromArtist(comboText);
  if (artistLang) return artistLang;

  // 4. Particle count
  const partLang = detectLanguageFromParticles(`${fileName} ${title}`);
  if (partLang) return partLang;

  // 5. franc-min su title+artist
  const fallbackText = [title, artist, recognizedTitle, recognizedArtist].filter(Boolean).join(' ');
  const francLang = detectLanguage(fallbackText);
  if (francLang) return francLang;

  // 6. Default: 'mixed' (mai 'instrumental' se non esplicito)
  return 'mixed';
}

module.exports = {
  detectLanguage,
  detectFromTrack,
  detectLanguageFromPath,
  detectLanguageFromParticles,
  detectLanguageFromArtist,
  hasInstrumentalHint,
  ISO_MAP,
};
