/**
 * src/services/lastfmService.js
 *
 * Enrichment genere via Last.fm top-tags dell'artista.
 * Ritorna il nostro genere interno corrispondente al tag più votato.
 *
 * API:
 *   getArtistGenreTags(artistName) → 'afrohouse'|... | null
 *   isConfigured()                 → bool (API key presente)
 *
 * Rate-limit: 5 req/sec → delay ≥260ms.
 * Fail-soft: errori → null.
 *
 * Dipendenze: last-fm, CONFIG
 */

'use strict';

const { CONFIG } = require('../constants/CONFIG');

// ---------------------------------------------------------------------------
// Mapping tag Last.fm → nostri generi interni
// ---------------------------------------------------------------------------

const LASTFM_TAG_MAP = {
  'afro house':     'afrohouse',
  'afrohouse':      'afrohouse',
  'afro':           'afrohouse',
  'tribal house':   'afrohouse',
  'tribal':         'afrohouse',
  'afrobeats':      'afrohouse',
  'amapiano':       'afrohouse',
  'tech house':     'techhouse',
  'techhouse':      'techhouse',
  'deep house':     'deephouse',
  'reggaeton':      'reggaeton',
  'reggaetón':      'reggaeton',
  'latin':          'reggaeton',
  'latin urban':    'reggaeton',
  'urbano latino':  'reggaeton',
  'trap latino':    'reggaeton',
  'latin trap':     'reggaeton',
  'dembow':         'dembow',
  'bachata':        'bachata',
  'salsa':          'bachata',
  'merengue':       'bachata',
  'house':          'house',
  'latin house':    'houselatino',
  'techno':         'techno',
  'trance':         'trance',
  'drum and bass':  'dnb',
  'dnb':            'dnb',
  'dubstep':        'dubstep',
  'trap':           'trap',
  'hip hop':        'hiphop',
  'hip-hop':        'hiphop',
  'rap':            'hiphop',
  'italian rap':    'hiphop',
  'pop':            'pop',
};

// ---------------------------------------------------------------------------
// Lazy client
// ---------------------------------------------------------------------------

let _client = null;
function getClient() {
  if (_client) return _client;
  const LastFM = require('last-fm');
  _client = new LastFM(CONFIG.lastfm?.key, { userAgent: 'DJLibraryManager/1.0' });
  return _client;
}

function isConfigured() {
  return !!(CONFIG.lastfm?.key);
}

// ---------------------------------------------------------------------------
// Rate-limit semaforo
// ---------------------------------------------------------------------------

let _lastCall = 0;
async function throttle() {
  const gap = CONFIG.lastfm?.requestDelayMs || 260;
  const since = Date.now() - _lastCall;
  if (since < gap) await new Promise(r => setTimeout(r, gap - since));
  _lastCall = Date.now();
}

// ---------------------------------------------------------------------------
// artistTopTags — wrap callback in Promise con timeout
// ---------------------------------------------------------------------------

function artistTopTagsPromise(client, artist, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => { if (!settled) { settled = true; err ? reject(err) : resolve(val); } };
    const timer = setTimeout(() => done(new Error('lastfm timeout')), timeoutMs);

    // last-fm espone artistTopTags(opts, cb) → { tags: [{ name, count }, ...] }
    if (typeof client.artistTopTags !== 'function') {
      clearTimeout(timer);
      return done(new Error('lastfm: artistTopTags non disponibile'));
    }
    client.artistTopTags({ name: artist }, (err, data) => {
      clearTimeout(timer);
      done(err, data);
    });
  });
}

// ---------------------------------------------------------------------------
// getArtistGenreTags — ritorna il genere interno del tag più votato
// ---------------------------------------------------------------------------

function mapTagToGenre(tagName) {
  if (!tagName) return null;
  const t = String(tagName).toLowerCase().trim();
  return LASTFM_TAG_MAP[t] || null;
}

async function getArtistGenreTags(artistName) {
  if (!isConfigured()) return null;
  if (!artistName) return null;

  const minCount = CONFIG.lastfm?.minCount ?? 50;
  const timeoutMs = CONFIG.lastfm?.requestTimeoutMs || 6_000;

  try {
    await throttle();
    const client = getClient();
    const data = await artistTopTagsPromise(client, artistName, timeoutMs);
    const tags = Array.isArray(data?.tags) ? data.tags : [];
    if (tags.length === 0) return null;

    // Ordina per count desc, prendi il primo che mappa
    const sorted = [...tags]
      .filter(t => Number(t?.count) >= minCount)
      .sort((a, b) => Number(b.count) - Number(a.count));

    for (const t of sorted) {
      const mapped = mapTagToGenre(t.name);
      if (mapped) return mapped;
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  getArtistGenreTags,
  mapTagToGenre,
  isConfigured,
  LASTFM_TAG_MAP,
};
