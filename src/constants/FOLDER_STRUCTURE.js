/**
 * src/constants/FOLDER_STRUCTURE.js
 *
 * Mappa (detectedGenre, vocalsLanguage, type) → path relativo Rekordbox-safe.
 *
 * REGOLE FINALI:
 *   1. Genre + lingua note    → cartella specifica (es. "Afro House Vocals Spagnole/Singoli")
 *   2. Genre noto, lingua no  → "{Genre} Vocals Miste/{Singoli|Mashup e Edit}"
 *   3. Genre no, info presenti → "Mashup e Edit Vari/{Singoli|Mashup e Edit}"
 *   4. type=mix               → SEMPRE "Mix e Set" (flat)
 *   5. Nessuna info utile     → "Da Rivedere" (flat)
 *   6. Lingua=instrumental    → "Strumentali" (flat)
 *   7. Track corrotta (status='error') → "Da Classificare" (flat)
 *
 * Sottocartelle Singoli/Mashup e Edit per TUTTI i generi tranne:
 *   Mix e Set, Da Rivedere, Strumentali, Da Classificare → flat
 *
 * I nomi sono Rekordbox-USB safe: solo ASCII, no accenti, ≤40 char.
 */

'use strict';

const path = require('path');

// Nomi cartelle — stile pulito, leggibili come frasi italiane.
// Esempi: "Afro House Spagnolo", "Tech House Italiano e Spagnolo", "Dembow".
// Niente trattini, parentesi, "Vocals", "IT x ES". Solo parole separate da spazio.

const _TO_CHECK = 'Da Controllare';

const FOLDER_NAMES = Object.freeze({
  // ── Afro House ─────────────────────────────────────────
  AFRO_HOUSE_ES:     'Afro House Spagnolo',
  AFRO_HOUSE_IT:     'Afro House Italiano',
  AFRO_HOUSE_ITES:   'Afro House Italiano e Spagnolo',
  AFRO_HOUSE_EN:     'Afro House Inglese',
  AFRO_HOUSE_MIXED:  'Afro House Misto',
  AFRO_HOUSE_INSTR:  'Afro House Strumentale',

  // ── Tech House ─────────────────────────────────────────
  TECH_HOUSE_ES:     'Tech House Spagnolo',
  TECH_HOUSE_IT:     'Tech House Italiano',
  TECH_HOUSE_ITES:   'Tech House Italiano e Spagnolo',
  TECH_HOUSE_EN:     'Tech House Inglese',
  TECH_HOUSE_MIXED:  'Tech House Misto',
  TECH_HOUSE_INSTR:  'Tech House Strumentale',
  TECH_HOUSE:        'Tech House Misto',  // alias fallback

  // ── Deep House ─────────────────────────────────────────
  DEEP_HOUSE_ES:     'Deep House Spagnolo',
  DEEP_HOUSE_IT:     'Deep House Italiano',
  DEEP_HOUSE_ITES:   'Deep House Italiano e Spagnolo',
  DEEP_HOUSE_EN:     'Deep House Inglese',
  DEEP_HOUSE_MIXED:  'Deep House Misto',
  DEEP_HOUSE_INSTR:  'Deep House Strumentale',
  DEEP_HOUSE:        'Deep House Misto',  // alias fallback

  // ── House Latino / House generico ──────────────────────
  HOUSE_LATINO_ES:   'House Latino',
  HOUSE_LATINO:      'House Latino',       // alias
  HOUSE_MIXED:       'House Misto',
  HOUSE_ES:          'House Latino',       // alias
  HOUSE_IT:          _TO_CHECK,
  HOUSE_EN:          'House Misto',        // alias
  HOUSE_ITES:        'House Latino',       // alias
  HOUSE:             'House Misto',        // alias fallback
  HOUSE_LATINO_IT:   _TO_CHECK,
  HOUSE_LATINO_EN:   _TO_CHECK,
  HOUSE_LATINO_ITES: 'House Latino',
  HOUSE_LATINO_MIXED: 'House Misto',

  // ── Reggaeton ──────────────────────────────────────────
  REGGAETON_ES:      'Reggaeton',
  REGGAETON_ITES:    'Reggaeton Italiano e Spagnolo',
  REGGAETON_MIXED:   'Reggaeton Misto',
  REGGAETON_IT:      'Reggaeton Misto',    // alias
  REGGAETON_EN:      'Reggaeton Misto',    // alias
  REGGAETON:         'Reggaeton',

  // ── Dembow ─────────────────────────────────────────────
  DEMBOW_ES:         'Dembow',
  DEMBOW_ITES:       'Dembow Italiano e Spagnolo',
  DEMBOW_MIXED:      'Dembow Misto',
  DEMBOW_IT:         'Dembow Misto',       // alias
  DEMBOW_EN:         'Dembow Misto',       // alias
  DEMBOW:            'Dembow',

  // ── Bachata ────────────────────────────────────────────
  BACHATA_ES:        'Bachata',
  BACHATA:           'Bachata',
  BACHATA_IT:        'Bachata',
  BACHATA_EN:        'Bachata',
  BACHATA_ITES:      'Bachata',
  BACHATA_MIXED:     'Bachata Misto',

  // ── Tribal ─────────────────────────────────────────────
  TRIBAL_ES:         'Tribal Spagnolo',
  TRIBAL_MIXED:      'Tribal Misto',
  TRIBAL:            'Tribal Misto',

  // ── Salsa / Tropical (nuovo) ───────────────────────────
  SALSA_TROPICAL:    'Salsa e Tropical',

  // ── Hip Hop (split per lingua) ─────────────────────────
  HIPHOP_IT:         'Hip Hop Italiano',
  HIPHOP_EN:         'Hip Hop Inglese',
  HIPHOP_ES:         'Hip Hop Spagnolo',
  HIPHOP_MIXED:      'Hip Hop Italiano',   // fallback conservativo (mercato IT)
  HIPHOP:            'Hip Hop Italiano',

  // ── Techno (flat, strumentale) ─────────────────────────
  TECHNO:            'Techno',

  // ── Generi minori (non più mappati esplicitamente → "Da Controllare") ──
  TRANCE:            _TO_CHECK,
  DNB:               _TO_CHECK,
  DUBSTEP:           _TO_CHECK,
  TRAP:              _TO_CHECK,
  POP:               _TO_CHECK,

  // ── Speciali (flat, no sottocartelle) ──────────────────
  MIX_SET:           'Mix e Set',
  MASHUP_VARI:       'Mashup e Edit',      // catch-all mashup senza genere
  TO_CHECK:          _TO_CHECK,

  // ── Alias legacy → "Da Controllare" (retrocompat codice esistente) ──
  INSTRUMENTALS:     _TO_CHECK,
  TO_REVIEW:         _TO_CHECK,
  UNCLASSIFIED:      _TO_CHECK,
});

const SUBFOLDERS = Object.freeze({
  SINGLES: 'Singoli',
  MASHUP:  'Mashup e Edit',
});

// Set di folder che NON hanno sottocartelle (sono flat)
const FLAT_FOLDERS = new Set([
  FOLDER_NAMES.MIX_SET,
  FOLDER_NAMES.MASHUP_VARI,
  FOLDER_NAMES.TO_CHECK,
]);

// ────────────────────────────────────────────────────────────────────
// Normalizzazione input
// ────────────────────────────────────────────────────────────────────

function normalizeGenreKey(g = '') {
  const s = String(g).toLowerCase().replace(/[\s\-_]+/g, '');
  if (!s) return 'unknown';
  if (/afrohouse/.test(s)) return 'afrohouse';
  if (/techhouse/.test(s)) return 'techhouse';
  if (/deephouse/.test(s)) return 'deephouse';
  if (s === 'reggaeton') return 'reggaeton';
  if (s === 'dembow') return 'dembow';
  if (s === 'bachata') return 'bachata';
  if (s === 'tribal') return 'tribal';
  if (/salsa/.test(s) || /tropical/.test(s)) return 'salsa';
  if (/houselatino/.test(s)) return 'houselatino';
  if (s === 'house') return 'house';
  if (s === 'techno') return 'techno';
  if (s === 'trance') return 'trance';
  if (s === 'dnb' || s === 'drumandbass' || s === 'drumbass') return 'dnb';
  if (s === 'dubstep') return 'dubstep';
  if (s === 'trap') return 'trap';
  if (s === 'hiphop' || s === 'rap') return 'hiphop';
  if (s === 'pop') return 'pop';
  if (s === 'unknown' || s === '') return 'unknown';
  return s;
}

function normalizeLangKey(l = '') {
  const s = String(l).toLowerCase().trim();
  if (!s) return 'unknown';
  if (/^(es|spa|spanish|spagnol\w*)$/.test(s)) return 'es';
  if (/^(it|ita|italian\w*)$/.test(s)) return 'it';
  if (/^(en|eng|english|ingles\w*)$/.test(s)) return 'en';
  if (s === 'it_es' || s === 'ites' || s === 'es_it') return 'it_es';
  if (s === 'mixed') return 'mixed';
  if (s === 'instrumental') return 'instrumental';
  return 'unknown';
}

// ────────────────────────────────────────────────────────────────────
// Heuristic: il track ha info utili per classificare?
// ────────────────────────────────────────────────────────────────────

function trackHasInfo(track) {
  if (!track) return false;
  const lt = String(track.localTitle || '').trim();
  const la = String(track.localArtist || '').trim();
  const rt = String(track.recognizedTitle || '').trim();
  const ra = String(track.recognizedArtist || '').trim();
  // Pattern "01 - Track 1" o nomi vuoti
  const isGenericTitle = (s) => !s || /^(track|untitled|new\s*recording|\d+\s*-?\s*track)\s*\d*$/i.test(s);
  if (track.isRecognized || rt || ra) return true;
  if (lt && !isGenericTitle(lt)) return true;
  if (la && la.length > 1) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────
// resolveTargetFolder — logica completa per Problema 4
// ────────────────────────────────────────────────────────────────────

function resolveTargetFolder(track = {}) {
  const type = String(track.type || '').toLowerCase();
  const isMashup = type === 'mashup' || !!track.isMashup;
  const sub = isMashup ? SUBFOLDERS.MASHUP : SUBFOLDERS.SINGLES;

  // Track in errore (corrotta/illeggibile) → Da Controllare
  if (track.status === 'error') return FOLDER_NAMES.TO_CHECK;

  // Mix → SEMPRE flat in Mix e Set
  if (type === 'mix' || track.isMix) return FOLDER_NAMES.MIX_SET;

  const genreKey = normalizeGenreKey(track.detectedGenre);
  const langKey  = normalizeLangKey(track.vocalsLanguage);
  const isGenreKnown = genreKey && genreKey !== 'unknown';

  if (isGenreKnown) {
    let parent = null;

    switch (genreKey) {
      // ── Afro House ─────────────────────────────────────────
      case 'afrohouse':
        if      (langKey === 'es')           parent = FOLDER_NAMES.AFRO_HOUSE_ES;
        else if (langKey === 'it')           parent = FOLDER_NAMES.AFRO_HOUSE_IT;
        else if (langKey === 'it_es')        parent = FOLDER_NAMES.AFRO_HOUSE_ITES;
        else if (langKey === 'en')           parent = FOLDER_NAMES.AFRO_HOUSE_EN;
        else if (langKey === 'instrumental') parent = FOLDER_NAMES.AFRO_HOUSE_INSTR;
        else                                 parent = FOLDER_NAMES.AFRO_HOUSE_MIXED;
        break;

      // ── Tech House ─────────────────────────────────────────
      case 'techhouse':
        if      (langKey === 'es')           parent = FOLDER_NAMES.TECH_HOUSE_ES;
        else if (langKey === 'it')           parent = FOLDER_NAMES.TECH_HOUSE_IT;
        else if (langKey === 'it_es')        parent = FOLDER_NAMES.TECH_HOUSE_ITES;
        else if (langKey === 'en')           parent = FOLDER_NAMES.TECH_HOUSE_EN;
        else if (langKey === 'instrumental') parent = FOLDER_NAMES.TECH_HOUSE_INSTR;
        else                                 parent = FOLDER_NAMES.TECH_HOUSE_MIXED;
        break;

      // ── Deep House ─────────────────────────────────────────
      case 'deephouse':
        if      (langKey === 'es')           parent = FOLDER_NAMES.DEEP_HOUSE_ES;
        else if (langKey === 'it')           parent = FOLDER_NAMES.DEEP_HOUSE_IT;
        else if (langKey === 'it_es')        parent = FOLDER_NAMES.DEEP_HOUSE_ITES;
        else if (langKey === 'en')           parent = FOLDER_NAMES.DEEP_HOUSE_EN;
        else if (langKey === 'instrumental') parent = FOLDER_NAMES.DEEP_HOUSE_INSTR;
        else                                 parent = FOLDER_NAMES.DEEP_HOUSE_MIXED;
        break;

      // ── House Latino ───────────────────────────────────────
      case 'houselatino':
        parent = FOLDER_NAMES.HOUSE_LATINO_ES;
        break;

      // ── House generico ─────────────────────────────────────
      case 'house':
        // House + ES o IT+ES → consideriamo Latino; altrimenti House Misto
        if (langKey === 'es' || langKey === 'it_es') parent = FOLDER_NAMES.HOUSE_LATINO_ES;
        else                                          parent = FOLDER_NAMES.HOUSE_MIXED;
        break;

      // ── Reggaeton ──────────────────────────────────────────
      case 'reggaeton':
        if      (langKey === 'es')    parent = FOLDER_NAMES.REGGAETON_ES;
        else if (langKey === 'it_es') parent = FOLDER_NAMES.REGGAETON_ITES;
        else                          parent = FOLDER_NAMES.REGGAETON_MIXED;
        break;

      // ── Dembow ─────────────────────────────────────────────
      case 'dembow':
        if      (langKey === 'es')    parent = FOLDER_NAMES.DEMBOW_ES;
        else if (langKey === 'it_es') parent = FOLDER_NAMES.DEMBOW_ITES;
        else                          parent = FOLDER_NAMES.DEMBOW_MIXED;
        break;

      // ── Bachata ────────────────────────────────────────────
      case 'bachata':
        parent = (langKey === 'es' || langKey === 'unknown')
          ? FOLDER_NAMES.BACHATA_ES
          : FOLDER_NAMES.BACHATA_MIXED;
        break;

      // ── Tribal ─────────────────────────────────────────────
      case 'tribal':
        parent = (langKey === 'es') ? FOLDER_NAMES.TRIBAL_ES : FOLDER_NAMES.TRIBAL_MIXED;
        break;

      // ── Hip Hop ────────────────────────────────────────────
      case 'hiphop':
        if      (langKey === 'it') parent = FOLDER_NAMES.HIPHOP_IT;
        else if (langKey === 'en') parent = FOLDER_NAMES.HIPHOP_EN;
        else if (langKey === 'es') parent = FOLDER_NAMES.HIPHOP_ES;
        else                       parent = FOLDER_NAMES.HIPHOP_IT;
        break;

      // ── Techno (flat, strumentale) ─────────────────────────
      case 'techno':
        parent = FOLDER_NAMES.TECHNO;
        break;

      // ── Salsa / Tropical ───────────────────────────────────
      case 'salsa':
        parent = FOLDER_NAMES.SALSA_TROPICAL;
        break;

      // trance / dnb / dubstep / trap / pop → non mappati → Da Controllare
      default:
        parent = null;
    }

    if (parent) {
      // Cartelle piatte (Techno, Salsa e Tropical ecc. quando servono) → no sub
      if (FLAT_FOLDERS.has(parent)) return parent;
      return `${parent}/${sub}`;
    }
  }

  // ── Genre NON noto ──────────────────────────────────────────────
  // Se è un mashup con qualche info → catch-all "Mashup e Edit" (FLAT)
  if (isMashup && trackHasInfo(track)) {
    return FOLDER_NAMES.MASHUP_VARI;
  }

  // Nessuna info utile o genere non mappato → "Da Controllare" (flat)
  return FOLDER_NAMES.TO_CHECK;
}

// ────────────────────────────────────────────────────────────────────
// Legacy buildPath (vecchia API)
// ────────────────────────────────────────────────────────────────────

const SKIP_LANGUAGE_LEVEL = new Set([
  'Techno', 'Trance', 'DnB', 'Dubstep', 'Hardstyle', 'AfroHouse', 'TechHouse',
]);

function buildPath({ genre = 'Unknown', language = 'Unknown', artist = 'Unknown Artist' } = {}) {
  const parts = [genre];
  const skipLang =
    SKIP_LANGUAGE_LEVEL.has(genre) ||
    language === 'Instrumental' ||
    language === 'Unknown' ||
    !language;
  if (!skipLang) parts.push(language);
  parts.push(artist);
  return parts.join(path.sep);
}

const FOLDER_STRUCTURE = Object.freeze({
  FOLDER_NAMES,
  SUBFOLDERS,
  FLAT_FOLDERS,
  resolveTargetFolder,
  ROOT: 'DJ Library Organizzata',
  SKIP_LANGUAGE_LEVEL,
  buildPath,
});

module.exports = {
  FOLDER_NAMES,
  SUBFOLDERS,
  FLAT_FOLDERS,
  resolveTargetFolder,
  normalizeGenreKey,
  normalizeLangKey,
  trackHasInfo,
  // legacy
  FOLDER_STRUCTURE,
  buildPath,
};
