/**
 * src/services/discogsService.js
 *
 * Enrichment genere via Discogs "styles" (più precisi dei "genres" generici).
 * Cerca release per "Artist Title", prende il primo risultato con score >= 70,
 * legge il primo style e lo mappa al nostro tassonomico interno.
 *
 * API:
 *   searchGenreOnDiscogs(track) → 'afrohouse'|'techhouse'|... | null
 *   isConfigured()              → bool (token presente)
 *
 * Rate-limit: 60 req/min con user-token → delay ≥1.1 s tra chiamate.
 * Fail-soft: errori di rete/API → null.
 *
 * Dipendenze: disconnect, CONFIG
 */

'use strict';

const { CONFIG } = require('../constants/CONFIG');

// ---------------------------------------------------------------------------
// Mapping styles Discogs → nostri generi interni (lowercase match)
// ---------------------------------------------------------------------------

const DISCOGS_STYLE_MAP = {
  'afro house':      'afrohouse',
  'afrohouse':       'afrohouse',
  'tribal house':    'afrohouse',
  'tribal':          'afrohouse',
  'afro':            'afrohouse',
  'tech house':      'techhouse',
  'techhouse':       'techhouse',
  'deep house':      'deephouse',
  'deephouse':       'deephouse',
  'house':           'house',
  'latin house':     'houselatino',
  'house latino':    'houselatino',
  'reggaeton':       'reggaeton',
  'reggaetón':       'reggaeton',
  'latin hip-hop':   'reggaeton',
  'latin urban':     'reggaeton',
  'trap latino':     'reggaeton',
  'dembow':          'dembow',
  'bachata':         'bachata',
  'salsa':           'bachata',           // routing vicino
  'techno':          'techno',
  'trance':          'trance',
  'drum n bass':     'dnb',
  'drum and bass':   'dnb',
  'dnb':             'dnb',
  'jungle':          'dnb',
  'dubstep':         'dubstep',
  'hip hop':         'hiphop',
  'hip-hop':         'hiphop',
  'rap':             'hiphop',
  'trap':            'trap',
  'pop':             'pop',
};

// ---------------------------------------------------------------------------
// Lazy Discogs client (disconnect)
// ---------------------------------------------------------------------------

let _db = null;
function getDatabase() {
  if (_db) return _db;
  const { Client } = require('disconnect');
  const token = CONFIG.discogs?.token;
  const client = token
    ? new Client('DJLibraryManager/1.0', { userToken: token })
    : new Client('DJLibraryManager/1.0');
  _db = client.database();
  return _db;
}

function isConfigured() {
  return !!(CONFIG.discogs?.token);
}

// ---------------------------------------------------------------------------
// Rate-limit semaforo (60 req/min con token)
// ---------------------------------------------------------------------------

let _lastCall = 0;
async function throttle() {
  const gap = CONFIG.discogs?.requestDelayMs || 1100;
  const since = Date.now() - _lastCall;
  if (since < gap) await new Promise(r => setTimeout(r, gap - since));
  _lastCall = Date.now();
}

// ---------------------------------------------------------------------------
// mapStylesToGenre — ordine: specifico prima di generico
// ---------------------------------------------------------------------------

function mapStylesToGenre(styles) {
  if (!Array.isArray(styles)) return null;
  const low = styles.map(s => String(s || '').toLowerCase().trim()).filter(Boolean);
  // Priorità: afrohouse/techhouse/reggaeton/dembow/bachata → poi generici
  const priority = [
    'afro house', 'afrohouse', 'tribal house',
    'tech house', 'techhouse',
    'deep house', 'deephouse',
    'reggaeton', 'reggaetón', 'latin hip-hop', 'latin urban', 'trap latino',
    'dembow', 'bachata',
    'latin house', 'house latino',
    'house', 'techno', 'trance',
    'drum n bass', 'drum and bass', 'dnb', 'jungle',
    'dubstep', 'trap',
    'hip hop', 'hip-hop', 'rap',
    'pop',
  ];
  for (const key of priority) {
    if (low.includes(key) && DISCOGS_STYLE_MAP[key]) {
      return DISCOGS_STYLE_MAP[key];
    }
  }
  // Fallback: primo style che matcha direttamente il nostro map
  for (const s of low) {
    if (DISCOGS_STYLE_MAP[s]) return DISCOGS_STYLE_MAP[s];
  }
  return null;
}

// ---------------------------------------------------------------------------
// searchGenreOnDiscogs — ritorna il genere interno o null
// ---------------------------------------------------------------------------

async function searchGenreOnDiscogs(track) {
  if (!isConfigured()) return null;
  const artist = track?.recognizedArtist || track?.localArtist;
  const title = track?.recognizedTitle || track?.localTitle;
  if (!artist || !title) return null;

  const timeoutMs = CONFIG.discogs?.requestTimeoutMs || 8_000;
  const minScore = CONFIG.discogs?.minScore ?? 70;

  try {
    await throttle();
    const db = getDatabase();
    const q = `${artist} ${title}`;

    const result = await Promise.race([
      db.search({ q, type: 'release', per_page: 5 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('discogs timeout')), timeoutMs)),
    ]);

    const list = Array.isArray(result?.results) ? result.results : [];
    if (list.length === 0) return null;

    // Prendi il primo risultato con community score sufficiente O il primo se assente
    let chosen = null;
    for (const r of list) {
      const score = Number(r?.community?.rating?.average) * 20 || 0; // 0-5 → 0-100
      if (score >= minScore) { chosen = r; break; }
    }
    if (!chosen) chosen = list[0];

    // I release hanno `style[]` (preciso per dance music) e `genre[]` (generico).
    // Priorità style → genre.
    const styles = Array.isArray(chosen.style) ? chosen.style : [];
    const genres = Array.isArray(chosen.genre) ? chosen.genre : [];
    const mapped = mapStylesToGenre(styles) || mapStylesToGenre(genres);
    return mapped || null;
  } catch {
    return null;
  }
}

module.exports = {
  searchGenreOnDiscogs,
  mapStylesToGenre,
  isConfigured,
  DISCOGS_STYLE_MAP,
};
