/**
 * src/utils/stringUtils.js
 *
 * Utility stringhe: normalizzazione titoli/artisti, similarità Levenshtein,
 * sanitize per filename e folder (Windows + USB Rekordbox safe),
 * rilevamento mashup/edit, conversione path → URI Rekordbox.
 *
 * Esporta (nuovi nomi): normalizeSongTitle, normalizeArtistName,
 *                       calculateSimilarity, sanitizeFileName,
 *                       sanitizeFolderName, isMashupOrEdit,
 *                       pathToRekordboxUri, applyTemplate
 * Alias retro-compat: normalize, similarity, sanitizeFilename
 *
 * Dipendenze: fastest-levenshtein
 */

'use strict';

const { distance } = require('fastest-levenshtein');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripDiacritics(s = '') {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Parole chiave che identificano varianti/edit e NON devono essere considerate
// nel titolo normalizzato per il matching doppioni.
const VARIANT_KEYWORDS = [
  'remix', 'edit', 'bootleg', 'mashup', 'blend', 'version',
  'afrohouse', 'tech house', 'tribal', 'extended',
];

const MASHUP_EDIT_KEYWORDS = [
  'mashup', 'edit', 'bootleg', 'blend',
  'afrohouse version', 'tech house version',
  'tribal', 'extended mix', 'instrumental',
  'acapella', 'acappella', 'transition',
];

// Superset: tracce derivate (include remix/rework/reboot). Usato dal
// sampling ACRCloud per spostare il punto di campionamento (al sec 60
// anziché 30, dove al 30 c'è spesso la base di un'altra canzone).
const DERIVATIVE_KEYWORDS = [
  ...MASHUP_EDIT_KEYWORDS,
  'remix', 'rework', 'reboot', 'flip', 'vip mix', 'rmx',
];

// ---------------------------------------------------------------------------
// normalizeSongTitle
// ---------------------------------------------------------------------------
/**
 * Normalizza un titolo di canzone per matching/similarità.
 * Esempio:
 *   "01. Bad Bunny ft. J Balvin - CARO (Afrohouse Remix 2023)"
 *   → "bad bunny caro"
 */
function normalizeSongTitle(str) {
  if (!str) return '';
  let s = String(str);

  // 1) Numero iniziale "01 - ", "02. ", "3 ."
  s = s.replace(/^\s*\d{1,3}\s*[-.)]\s*/, '');

  // 2) "feat/ft/featuring ... -"  (rimuove tutto fino al primo trattino successivo)
  s = s.replace(/\s*(feat|ft|featuring)\.?\s+[^-]*-/gi, ' ');

  // 3) Parentesi tonde/quadre contenenti VARIANT_KEYWORDS (remix, edit, bootleg, ecc.)
  const kwAlt = VARIANT_KEYWORDS.map(k => k.replace(/\s+/g, '\\s+')).join('|');
  const kwRegex = new RegExp(`[\\(\\[][^\\)\\]]*?(${kwAlt})[^\\)\\]]*?[\\)\\]]`, 'gi');
  s = s.replace(kwRegex, ' ');

  // 4) Rimuove parentesi/quadre vuote o residue
  s = s.replace(/[\(\[][^\)\]]*[\)\]]/g, match => {
    // Se la parentesi non contiene più keyword né contenuti utili → rimuovi
    // Manteniamo solo se contiene >2 alfanumerici (magari un altro titolo).
    const inner = match.replace(/[\(\[\)\]]/g, '').trim();
    return /[a-z0-9]{3,}/i.test(inner) ? match : ' ';
  });
  s = s.replace(/[\(\[][\s]*[\)\]]/g, ' ');

  // 5) Rimuovi caratteri speciali tranne lettere/cifre/spazi
  s = s.replace(/[^a-zA-Z0-9\s]/g, ' ');

  // 6) Lowercase + collassa spazi + trim
  s = s.toLowerCase().replace(/\s+/g, ' ').trim();
  return s;
}

// ---------------------------------------------------------------------------
// normalizeArtistName
// ---------------------------------------------------------------------------
/**
 * "J. Balvin" → "j balvin"; "Rauw Alejandro" → "rauw alejandro"
 */
function normalizeArtistName(str) {
  if (!str) return '';
  let s = stripDiacritics(String(str));
  s = s.replace(/[^a-zA-Z0-9\s]/g, ' '); // via punteggiatura
  s = s.toLowerCase().replace(/\s+/g, ' ').trim();
  return s;
}

// ---------------------------------------------------------------------------
// calculateSimilarity
// ---------------------------------------------------------------------------
/**
 * Similarity 0..1 basata su Levenshtein, applicata DOPO normalizzazione
 * (usa normalizeSongTitle per dare peso ai termini significativi).
 */
function calculateSimilarity(str1, str2) {
  const a = normalizeSongTitle(str1);
  const b = normalizeSongTitle(str2);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - (distance(a, b) / maxLen);
}

// ---------------------------------------------------------------------------
// sanitizeFileName
// ---------------------------------------------------------------------------
/**
 * Per NOMI FILE. Rimuove caratteri illegali Windows, normalizza apostrofi
 * curvi, tronca a 120 char, trim di spazi e punti.
 */
function sanitizeFileName(str) {
  if (!str) return 'untitled';
  let s = String(str);
  // Apostrofi curvi (’‘‛) → '
  s = s.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  // Virgolette curve → "
  s = s.replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  // Caratteri illegali Windows
  s = s.replace(/[\\/:*?"<>|\x00-\x1F]/g, ' ');
  // Collassa spazi
  s = s.replace(/\s+/g, ' ').trim();
  // Rimuovi trailing dots/spaces (invalidi in Windows)
  s = s.replace(/[. ]+$/, '');
  // Nomi riservati Windows
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(s)) s = `_${s}`;
  // Max 120 char
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s || 'untitled';
}

// ---------------------------------------------------------------------------
// sanitizeFolderName
// ---------------------------------------------------------------------------
/**
 * Per NOMI CARTELLA USB/Rekordbox. Solo ASCII: lettere, cifre, spazi, trattino.
 * Rimuove accenti. Max 40 char.
 */
function sanitizeFolderName(str) {
  if (!str) return 'Unknown';
  let s = stripDiacritics(String(str));
  s = s.replace(/[^A-Za-z0-9\s\-]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 40) s = s.slice(0, 40).trim();
  return s || 'Unknown';
}

// ---------------------------------------------------------------------------
// isMashupOrEdit
// ---------------------------------------------------------------------------
function isMashupOrEdit(title) {
  if (!title) return false;
  const low = String(title).toLowerCase();
  return MASHUP_EDIT_KEYWORDS.some(k => low.includes(k));
}

// isDerivative = mashup/edit + remix/rework/reboot/flip — per sampling ACR
function isDerivative(title) {
  if (!title) return false;
  const low = String(title).toLowerCase();
  return DERIVATIVE_KEYWORDS.some(k => low.includes(k));
}

// ---------------------------------------------------------------------------
// parseFileNameForMetadata
// ---------------------------------------------------------------------------
/**
 * Estrae artist/title da un nome file tipo:
 *   "Bad_Bunny_-_Safaera_Afro_House_KLICKAUD.mp3" →
 *     { artist: "Bad Bunny", title: "Safaera Afro House" }
 *
 * Usato come fallback quando ACRCloud non raggiunge la confidence minima.
 * Ritorna stringhe vuote se il nome non ha il separatore " - ".
 */
// Pattern ispirati al plugin `fromfilename` di beets (https://beets.io).
// L'ordine conta: pattern più specifici prima dei più generici.
const FILENAME_PATTERNS = [
  // 1. Track number: "01 - Artist - Title", "05. Artist - Title"
  {
    re: /^\s*(\d{1,3})\s*[-.)]\s*(.+?)\s+-\s+(.+)$/,
    map: m => ({ trackNum: parseInt(m[1], 10), artist: m[2].trim(), title: m[3].trim() }),
  },
  // 2. Due artisti con "X"/"vs"/"&": "Artist X Artist2 - Title"
  {
    re: /^(.+?)\s+(?:[Xx×]|vs\.?|&|feat\.?|ft\.?)\s+(.+?)\s+-\s+(.+)$/,
    map: m => ({ artist: `${m[1].trim()} x ${m[2].trim()}`, title: m[3].trim() }),
  },
  // 3. Anno a fine titolo: "Artist - Title (2017)" / "[2021]"
  {
    re: /^(.+?)\s+-\s+(.+?)\s*[\(\[](?:19|20)\d{2}[\)\]]\s*$/,
    map: m => ({ artist: m[1].trim(), title: m[2].trim() }),
  },
  // 4. Default: "Artist - Title"
  {
    re: /^(.+?)\s+-\s+(.+)$/,
    map: m => ({ artist: m[1].trim(), title: m[2].trim() }),
  },
];

function parseFileNameForMetadata(fileName) {
  if (!fileName) return { artist: '', title: '' };
  const name = String(fileName)
    .replace(/\.(mp3|wav|flac|aac|m4a|aiff?|ogg|wma)$/i, '')
    .replace(/_/g, ' ')
    .replace(/\b(KLICKAUD|SPOTDOWN|SOUNDCLOUD|FREE.?DL|PITCHED|COPYRIGHT|DOWNLOAD|128K|320K|HQ)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  for (const { re, map } of FILENAME_PATTERNS) {
    const m = name.match(re);
    if (!m) continue;
    const raw = map(m);
    if (raw.artist && raw.title) {
      // Rimuovi tag variante dal titolo (preservato nel file originale)
      const title = String(raw.title)
        .replace(/\b(remix|edit|mashup|blend|version|extended|rework|reboot|bootleg)\b/gi, '')
        .replace(/\s*[\(\[]\s*[\)\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        artist: raw.artist,
        title,
        ...(raw.trackNum ? { trackNum: raw.trackNum } : {}),
      };
    }
  }

  return { artist: '', title: name };
}

// ---------------------------------------------------------------------------
// pathToRekordboxUri
// ---------------------------------------------------------------------------
/**
 * "D:\USB\DJ Library Organizzata\Reggaeton\Singoli\Rauw - Todo de Ti.mp3"
 *   → "file://localhost/D:/USB/DJ%20Library%20Organizzata/Reggaeton/Singoli/Rauw%20-%20Todo%20de%20Ti.mp3"
 *
 * - Sostituisce \ con /
 * - Prepende "file://localhost/"
 * - encodeURIComponent per ogni segmento, ECCETTO quello che contiene ':'
 *   (la lettera di drive Windows "D:")
 * - Preserva caratteri Rekordbox-friendly che encodeURIComponent codifica:
 *     ( → preservato (era %28)
 *     ) → preservato (era %29)
 *     ' → preservato (era %27)
 *     , → preservato (era %2C)
 *   Spazi → %20 (corretto per file:// URI).
 */
function pathToRekordboxUri(absolutePath) {
  if (!absolutePath) return '';
  const forward = String(absolutePath).replace(/\\/g, '/');
  const segments = forward.split('/');
  const encoded = segments
    .map(seg => {
      if (seg.includes(':')) return seg; // drive letter "D:"
      return encodeURIComponent(seg)
        .replace(/%28/g, '(')
        .replace(/%29/g, ')')
        .replace(/%27/g, "'")
        .replace(/%2C/g, ',');
    })
    .join('/');
  return 'file://localhost/' + encoded;
}

// ---------------------------------------------------------------------------
// applyTemplate (già esistente)
// ---------------------------------------------------------------------------
function applyTemplate(template, data = {}) {
  let out = String(template).replace(/\{(\w+)\}/g, (_, k) => {
    const v = data[k];
    return (v === undefined || v === null || v === '') ? '' : String(v);
  });
  out = out.replace(/\[\s*\]/g, '').replace(/\(\s*\)/g, '');
  out = out.replace(/\s+/g, ' ').replace(/\s-\s+$/, '').trim();
  return out;
}

// ---------------------------------------------------------------------------
// Retrocompatibilità (alias vecchi nomi usati da altri service)
// ---------------------------------------------------------------------------
const normalize = normalizeSongTitle;
const similarity = calculateSimilarity;
const sanitizeFilename = sanitizeFileName;

// ---------------------------------------------------------------------------
// parseFileNameDetailed — analisi completa del nome file
// ---------------------------------------------------------------------------
// Ritorna: { baseGenre, language, isMashup, artist, title,
//           foundArtistsES[], foundArtistsIT[], rawClean }
// Usato dal classificatore per combinare "genere base" + "lingua vocals".

function parseFileNameDetailed(fileName) {
  if (!fileName) {
    return {
      baseGenre: null, language: null, isMashup: false,
      artist: '', title: '',
      foundArtistsES: [], foundArtistsIT: [], rawClean: '',
    };
  }

  // 1. Pulizia (strip estensione, underscore, suffissi scraper)
  const clean = String(fileName)
    .replace(/\.(mp3|wav|flac|aac|m4a|aiff?|ogg|wma)$/i, '')
    .replace(/_/g, ' ')
    .replace(/\b(KLICKAUD|SPOTDOWN|SOUNDCLOUD|FREE.?DL|PITCHED|COPYRIGHT|DOWNLOAD|DESCARGA|MEDAL|HQ|128K|192K|256K|320K)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = clean.toLowerCase();

  // 2. Genere base dal nome
  let baseGenre = null;
  if      (/\b(afro.?house|afrohouse)\b/.test(lower)) baseGenre = 'afrohouse';
  else if (/\b(tech.?house|techhouse)\b/.test(lower)) baseGenre = 'techhouse';
  else if (/\b(deep.?house|deephouse)\b/.test(lower)) baseGenre = 'deephouse';
  else if (/\b(dembow|mambo)\b/.test(lower))           baseGenre = 'dembow';
  else if (/\b(reggaeton|reggaetón|rkt)\b/.test(lower)) baseGenre = 'reggaeton';
  else if (/\bbachata\b/.test(lower))                  baseGenre = 'bachata';
  else if (/\btribal\b/.test(lower))                   baseGenre = 'afrohouse';
  else if (/\b(drum.?and.?bass|dnb)\b/.test(lower))    baseGenre = 'dnb';
  else if (/\btechno\b/.test(lower))                   baseGenre = 'techno';
  else if (/\btrance\b/.test(lower))                   baseGenre = 'trance';
  else if (/\bdubstep\b/.test(lower))                  baseGenre = 'dubstep';
  else if (/\btrap\b/.test(lower))                     baseGenre = 'trap';
  else if (/\b(hip.?hop|^rap\b)/.test(lower))          baseGenre = 'hiphop';

  // 3. Artisti nel nome (per lingua vocals)
  const { GENRE_RULES } = require('../constants/GENRE_RULES');
  const langHints = GENRE_RULES.ARTIST_LANG_HINTS || {};
  const foundES = [];
  const foundIT = [];
  const foundEN = [];
  for (const [artistKey, lang] of Object.entries(langHints)) {
    if (lower.includes(artistKey)) {
      if      (lang === 'es') foundES.push(artistKey);
      else if (lang === 'it') foundIT.push(artistKey);
      else if (lang === 'en') foundEN.push(artistKey);
    }
  }

  // 4. Determina lingua (mappa it_es per misti IT+ES)
  let language = null;
  if (foundES.length > 0 && foundIT.length === 0 && foundEN.length === 0) language = 'es';
  else if (foundIT.length > 0 && foundES.length === 0 && foundEN.length === 0) language = 'it';
  else if (foundEN.length > 0 && foundES.length === 0 && foundIT.length === 0) language = 'en';
  else if (foundIT.length > 0 && foundES.length > 0 && foundEN.length === 0)    language = 'it_es';
  else if (foundIT.length + foundES.length + foundEN.length > 0)                language = 'mixed';

  // 5. Mashup?
  //    - keyword esplicita: mashup/edit/bootleg/blend/rework/flip/redrum/transition/reboot
  //    - DUE artisti nel nome file (foundES+foundIT+foundEN >= 2)
  //    - "Artist x Artist2" / "Artist vs Artist2" / "Artist feat Artist2" prima di "-"
  const hasMashupKw = /\b(mashup|edit|bootleg|blend|rework|flip|redrum|transition|remake|reboot|vip\s*mix)\b/i.test(lower);
  const totalArtists = foundES.length + foundIT.length + foundEN.length;
  const hasXPattern = /\b[\w'-]+\s+[xX×]\s+[\w'-]+\s*-/.test(clean) ||
                      /\b[\w'-]+\s+(vs\.?|feat\.?|ft\.?)\s+[\w'-]+\s*-/i.test(clean);
  const isMashup = hasMashupKw || totalArtists >= 2 || hasXPattern;

  // 6. Artist / Title split (primo "  -  " della stringa pulita)
  const parts = clean.split(/\s+-\s+/);
  let artist = '';
  let title = clean;
  if (parts.length >= 2) {
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ')
      .replace(/\b(mashup|edit|bootleg|blend|afro.?house|tech.?house|deep.?house|dembow|reggaeton|bachata|remix|version|extended|rework|reboot)\b/gi, '')
      .replace(/\s*[\(\[]\s*[\)\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return {
    baseGenre,
    language,
    isMashup,
    artist,
    title,
    foundArtistsES: foundES,
    foundArtistsIT: foundIT,
    foundArtistsEN: foundEN,
    rawClean: clean,
  };
}

module.exports = {
  // Nuovi nomi (spec)
  normalizeSongTitle,
  normalizeArtistName,
  calculateSimilarity,
  sanitizeFileName,
  sanitizeFolderName,
  isMashupOrEdit,
  isDerivative,
  parseFileNameForMetadata,
  parseFileNameDetailed,
  pathToRekordboxUri,
  applyTemplate,
  // Alias retro-compat
  normalize,
  similarity,
  sanitizeFilename,
  stripDiacritics,
};
