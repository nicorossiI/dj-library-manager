/**
 * src/services/genreClassifierService.js
 *
 * Classificazione genere + lingua a CASCATA (spec utente).
 * Priorità decrescente — first match wins:
 *   1. Percorso cartella padre                        (conf 0.90)
 *   2. Keyword genere nel nome file normalizzato      (conf 0.85)
 *   3. Artisti nel nome file (ARTIST_GENRE_HINTS)     (conf 0.80)
 *   4. Tag ID3 localGenre                             (conf 0.70)
 *   5. ARTIST_GENRE_HINTS su recognizedArtist (ACR)   (conf 0.65)
 *   6. Keyword nel recognizedTitle (ACRCloud)         (conf 0.50)
 *   7. BPM range                                      (conf 0.30)
 *   8. Default: unknown → Da Rivedere / Mashup Vari
 *
 * Strumentali SOLO con keyword esplicita (gestito in languageUtils).
 *
 * Output: chiavi lowercase compatibili con FOLDER_STRUCTURE.normalizeGenreKey
 *   (afrohouse/techhouse/reggaeton/dembow/bachata/houselatino/house/...)
 */

'use strict';

const path = require('path');
const { GENRE_RULES } = require('../constants/GENRE_RULES');
const { bpmToGenreHints } = require('../utils/bpmUtils');
const { detectFromTrack } = require('../utils/languageUtils');
const { parseFileNameDetailed } = require('../utils/stringUtils');
const discogsService = require('./discogsService');
const lastfmService = require('./lastfmService');

// ---------------------------------------------------------------------------
// normalizeFileName — strip estensione, underscore, suffix scraper/tagging
// ---------------------------------------------------------------------------

function normalizeFileName(fileName = '') {
  return String(fileName)
    .replace(/\.(mp3|wav|flac|aac|m4a|aiff?|ogg)$/i, '')
    .replace(/_/g, ' ')
    .replace(/\b(KLICKAUD|SPOTDOWN|SOUNDCLOUD|FREE.?DL|DOWNLOAD|PITCHED|COPYRIGHT|128K|320K|HQ)\b/gi, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// ---------------------------------------------------------------------------
// detectGenreFromText — scan PATH_KEYWORDS_ORDERED (case-insensitive)
// ---------------------------------------------------------------------------

function detectGenreFromText(text) {
  if (!text) return '';
  const low = String(text).toLowerCase();
  for (const [canonical, kws] of GENRE_RULES.PATH_KEYWORDS_ORDERED) {
    if (kws.some(k => low.includes(k))) return canonical;
  }
  return '';
}

// ---------------------------------------------------------------------------
// detectGenreFromPath — check espliciti sulla cartella padre (FIX 2)
// Usa word-boundary per evitare "technology"/"africa" come falsi positivi.
// ---------------------------------------------------------------------------

function detectGenreFromPath(filePath) {
  if (!filePath) return '';
  const dir = path.dirname(String(filePath)).toLowerCase();
  if (/\bdembow\b/.test(dir))    return 'dembow';
  if (/\breggaeton\b/.test(dir)) return 'reggaeton';
  if (/\bbachata\b/.test(dir))   return 'bachata';
  if (/\btech\b/.test(dir))      return 'techhouse';
  if (/\bafro\b/.test(dir))      return 'afrohouse';
  return '';
}

// ---------------------------------------------------------------------------
// Shazam genre mapping — Shazam.track.genres.primary → chiave canonica interna
// ---------------------------------------------------------------------------

const SHAZAM_GENRE_MAP = Object.freeze({
  'latin':              'reggaeton',
  'reggaeton & urban':  'reggaeton',
  'urban latino':       'reggaeton',
  'latin urban':        'reggaeton',
  'trap latino':        'dembow',
  'dembow':             'dembow',
  'bachata':            'bachata',
  'salsa y tropical':   'salsa',
  'tropical':           'salsa',
  'salsa':              'salsa',
  'afrobeats':          'afrohouse',
  'afro':               'afrohouse',
  'dance & electronic': 'techhouse',
  'electronic':         'techhouse',
  'house':              'house',
  'deep house':         'deephouse',
  'tech house':         'techhouse',
  'techno':             'techno',
  'hip-hop/rap':        'hiphop',
  'hip hop':            'hiphop',
  'rap':                'hiphop',
  'r&b/soul':           'hiphop',
  'r&b':                'hiphop',
});

function mapShazamGenre(raw = '') {
  if (!raw) return '';
  const key = String(raw).toLowerCase().trim();
  if (SHAZAM_GENRE_MAP[key]) return SHAZAM_GENRE_MAP[key];
  // substring match — "Dance & Electronic / House" ecc.
  for (const [k, v] of Object.entries(SHAZAM_GENRE_MAP)) {
    if (key.includes(k)) return v;
  }
  return '';
}

// ---------------------------------------------------------------------------
// normalizeGenreTag — tag ID3 raw → chiave lowercase canonica
// ---------------------------------------------------------------------------

function normalizeGenreTag(raw = '') {
  if (!raw) return '';
  const low = String(raw).trim().toLowerCase();
  const norm = GENRE_RULES.GENRE_NORMALIZATION[low];
  if (norm) return norm.toLowerCase();
  const fromKw = detectGenreFromText(low);
  if (fromKw) return fromKw;
  return low;
}

// ---------------------------------------------------------------------------
// detectGenreFromArtist — lookup ARTIST_GENRE_HINTS su campo artista
// ---------------------------------------------------------------------------

function detectGenreFromArtist(artist = '') {
  if (!artist) return '';
  const key = String(artist).toLowerCase().trim().replace(/\s+/g, ' ');
  const direct = GENRE_RULES.ARTIST_GENRE_HINTS[key];
  if (direct) return direct;
  const firstToken = key.split(/\s+(?:feat\.?|ft\.?|x|vs\.?|&|,)\s+/i)[0];
  if (firstToken && firstToken !== key) {
    const hit = GENRE_RULES.ARTIST_GENRE_HINTS[firstToken];
    if (hit) return hit;
  }
  return '';
}

// ---------------------------------------------------------------------------
// detectArtistInFileName — scan ARTIST_GENRE_HINTS come substring nel nome
// Ordina per lunghezza decrescente: artisti più lunghi (più specifici) prima.
// ---------------------------------------------------------------------------

let _artistKeysByLen = null;
function getArtistKeysByLen() {
  if (_artistKeysByLen) return _artistKeysByLen;
  _artistKeysByLen = Object.keys(GENRE_RULES.ARTIST_GENRE_HINTS)
    .sort((a, b) => b.length - a.length);
  return _artistKeysByLen;
}

function detectArtistInFileName(normalizedName) {
  if (!normalizedName) return '';
  const keys = getArtistKeysByLen();
  for (const artistKey of keys) {
    if (normalizedName.includes(artistKey)) {
      return GENRE_RULES.ARTIST_GENRE_HINTS[artistKey];
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// classify — cascata 7 step (spec utente)
// ---------------------------------------------------------------------------

/**
 * Cascata priorità (first match wins):
 *   1. Percorso cartella padre             (conf 0.90, source 'path')
 *   2. Keyword genere nel nome file        (conf 0.85, source 'filename')
 *   3. Artisti nel nome file               (conf 0.80, source 'artist_filename')
 *  3b. Discogs styles (solo se isRecognized) (conf 0.82, source 'discogs')
 *   4. Tag ID3 localGenre                  (conf 0.70, source 'id3_genre')
 *  4b. Last.fm artist top-tags             (conf 0.75, source 'lastfm')
 *   5. ARTIST_GENRE_HINTS su recognized    (conf 0.65, source 'artist_hint')
 *  5b. mbGenre (MusicBrainz tags)          (conf 0.60, source 'mbgenre')
 *   6. Keyword recognizedTitle             (conf 0.50, source 'title_kw')
 *   7. BPM range                           (conf 0.30, source 'bpm_range')
 *   8. Default unknown                     (conf 0.10, source 'none')
 *
 * ASYNC: chiamate Discogs/Last.fm sono network (rate-limited). Vengono
 * invocate SOLO quando gli step sync precedenti non matchano → costo bounded.
 */
async function classify(track) {
  if (!track) return { genre: 'unknown', subgenre: '', language: 'mixed', confidence: 0, source: 'none', details: null };

  const filePath         = track.filePath || '';
  const fileName         = track.fileName || (filePath ? path.basename(filePath) : '');
  const normalizedName   = normalizeFileName(fileName);
  const localGenre       = track.localGenre || track.genre || '';
  const recognizedTitle  = track.recognizedTitle || '';
  const recognizedArtist = track.recognizedArtist || '';

  // ── Analisi dettagliata nome file (per combinare base+vocals) ───
  const fileDetails = parseFileNameDetailed(fileName);

  // Se nel nome file ci sono 2+ artisti noti o keyword mashup → marca isMashup
  // (sovrascrive solo se non già esplicitamente marcato)
  if (fileDetails.isMashup && !track.isMashup && track.type !== 'mix') {
    track.isMashup = true;
    track.type = 'mashup';
  }
  // Se parseFileNameDetailed ha trovato una lingua (anche it_es) e track.vocalsLanguage
  // non è ancora settato, la usiamo come hint per finalize()
  if (fileDetails.language && !track.vocalsLanguage) {
    track.vocalsLanguage = fileDetails.language;
  }

  // ── 1) Percorso cartella padre ───────────────────────────────────
  const pathGenre = detectGenreFromPath(filePath);
  if (pathGenre) return finalize(pathGenre, 0.90, track, 'path');

  // ── 2) Keyword genere nel nome file normalizzato ─────────────────
  const fileGenre = detectGenreFromText(normalizedName);
  if (fileGenre) return finalize(fileGenre, 0.85, track, 'filename');

  // ── 3) Artisti nel nome file ─────────────────────────────────────
  const artistFileGenre = detectArtistInFileName(normalizedName);
  if (artistFileGenre) return finalize(artistFileGenre, 0.80, track, 'artist_filename');

  // ── 3b) Discogs styles (solo se ACRCloud ha dato artist+title) ───
  if (track.isRecognized && recognizedArtist && recognizedTitle && discogsService.isConfigured()) {
    try {
      const g = await discogsService.searchGenreOnDiscogs(track);
      if (g) {
        track.genreSource = 'discogs';
        return finalize(g, 0.82, track, 'discogs');
      }
    } catch { /* noop */ }
  }

  // ── 4) Tag ID3 localGenre ────────────────────────────────────────
  if (localGenre) {
    const g = normalizeGenreTag(localGenre);
    if (g && g !== 'unknown') return finalize(g, 0.70, track, 'id3_genre');
  }

  // ── 4b) Last.fm artist top-tags (se artista disponibile) ─────────
  if (recognizedArtist && lastfmService.isConfigured()) {
    try {
      const g = await lastfmService.getArtistGenreTags(recognizedArtist);
      if (g) {
        track.genreSource = 'lastfm';
        return finalize(g, 0.75, track, 'lastfm');
      }
    } catch { /* noop */ }
  }

  // ── 5) ARTIST_GENRE_HINTS su recognizedArtist ────────────────────
  const artistGenre = detectGenreFromArtist(recognizedArtist);
  if (artistGenre) return finalize(artistGenre, 0.65, track, 'artist_hint');

  // ── 5b) mbGenre (MusicBrainz tags da AcoustID fallback) ──────────
  if (track.mbGenre) return finalize(String(track.mbGenre).toLowerCase(), 0.60, track, 'mbgenre');

  // ── 5c) shazamGenre (se Shazam ha dato un genere mappabile) ──────
  if (track.shazamGenre) {
    const mapped = mapShazamGenre(track.shazamGenre);
    if (mapped) return finalize(mapped, 0.65, track, 'shazam_genre');
  }

  // ── 6) Keyword nel recognizedTitle ───────────────────────────────
  const titleGenre = detectGenreFromText(recognizedTitle);
  if (titleGenre) return finalize(titleGenre, 0.50, track, 'title_kw');

  // ── 7) BPM range ─────────────────────────────────────────────────
  if (track.bpm && Number.isFinite(track.bpm)) {
    const hints = bpmToGenreHints(track.bpm);
    if (hints.length) {
      return finalize(String(hints[0]).toLowerCase(), 0.30, track, 'bpm_range');
    }
  }

  // ── 8) Default: unknown ──────────────────────────────────────────
  return finalize('unknown', 0.1, track, 'none');
}

function finalize(genre, confidence, track, source) {
  const language = detectFromTrack(track);
  if (track.bpm && Number.isFinite(track.bpm)) {
    const rangeKey = genreToBpmRangeKey(genre);
    const range = rangeKey ? GENRE_RULES.BPM_RANGES[rangeKey] : null;
    if (range) {
      if (track.bpm < range.min - 5 || track.bpm > range.max + 5) {
        confidence = Math.max(0.3, confidence - 0.15);
      } else {
        confidence = Math.min(1, confidence + 0.05);
      }
    }
  }

  // Details leggibili sulla derivazione della decisione.
  const fileName = track.fileName || (track.filePath ? path.basename(track.filePath) : '');
  const fd = parseFileNameDetailed(fileName);
  const artistsES = fd.foundArtistsES || [];
  const artistsIT = fd.foundArtistsIT || [];
  const artistsEN = fd.foundArtistsEN || [];
  const vocalsBreakdown = [];
  if (artistsIT.length) vocalsBreakdown.push(...artistsIT.map(a => `${a}=IT`));
  if (artistsES.length) vocalsBreakdown.push(...artistsES.map(a => `${a}=ES`));
  if (artistsEN.length) vocalsBreakdown.push(...artistsEN.map(a => `${a}=EN`));

  const trackType = track.isMix ? 'mix' : (track.isMashup || fd.isMashup ? 'mashup' : 'single');

  return {
    genre,
    subgenre: '',
    language,
    confidence: Math.round(confidence * 100) / 100,
    source: source || 'none',
    details: {
      baseGenreFromFileName: fd.baseGenre,
      vocalsArtists: vocalsBreakdown,
      type: trackType,
      isMashupFromFile: fd.isMashup,
    },
  };
}

// BPM_RANGES è in PascalCase; il classificatore emette lowercase.
function genreToBpmRangeKey(genreLower) {
  const map = {
    afrohouse: 'AfroHouse',
    techhouse: 'TechHouse',
    deephouse: 'DeepHouse',
    reggaeton: 'Reggaeton',
    dembow:    'Reggaeton',
    bachata:   'Latin',
    houselatino: 'House',
    house:     'House',
    techno:    'Techno',
    trance:    'Trance',
    dnb:       'DnB',
    dubstep:   'Dubstep',
    hardstyle: 'Hardstyle',
    trap:      'Trap',
    hiphop:    'HipHop',
    pop:       'Pop',
  };
  return map[genreLower] || null;
}

module.exports = {
  classify,
  normalizeGenreTag,
  normalizeFileName,
  detectGenreFromText,
  detectGenreFromPath,
  detectGenreFromArtist,
  detectArtistInFileName,
};
