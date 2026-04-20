/**
 * src/constants/embeddedKeysLoader.js
 *
 * Carica le chiavi embedded con priorità:
 *   1. ./embedded-keys.local.js  (gitignored, chiavi amministratore nel build)
 *   2. ./embedded-keys.js        (committed, template vuoto — fallback)
 *
 * Esporta: getEmbeddedKeys() — ritorna oggetto { acrcloud:{host,key,secret},
 *                              acoustid, replicate, discogs, lastfm }
 *
 * Helpers `pick*()` unificano la cascata:
 *   userSettings → process.env → embedded
 * Usati da main/handlers e services al boot.
 */

'use strict';

let _cache = null;

function loadEmbedded() {
  if (_cache) return _cache;

  // .local.js ha priorità (chiavi reali dell'amministratore)
  try {
    // eslint-disable-next-line global-require
    _cache = require('./embedded-keys.local');
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') {
      console.warn('[embedded-keys] load local error:', err.message);
    }
    // Fallback al template vuoto committed
    // eslint-disable-next-line global-require
    _cache = require('./embedded-keys');
  }
  return _cache;
}

function getEmbeddedKeys() {
  const e = loadEmbedded() || {};
  return {
    acrcloud: {
      host:   e.acrcloud?.host   || '',
      key:    e.acrcloud?.key    || '',
      secret: e.acrcloud?.secret || '',
    },
    acoustid:  String(e.acoustid  || ''),
    replicate: String(e.replicate || ''),
    discogs:   String(e.discogs   || ''),
    lastfm:    String(e.lastfm    || ''),
  };
}

/** True se almeno una chiave API è bundled. */
function hasAnyEmbeddedKey() {
  const e = getEmbeddedKeys();
  return !!(
    e.acrcloud.key || e.acoustid || e.replicate || e.discogs || e.lastfm
  );
}

/** Info per diagnostica UI (quali chiavi sono precompilate). */
function getEmbeddedKeyFlags() {
  const e = getEmbeddedKeys();
  return {
    acrcloud:  !!(e.acrcloud.host && e.acrcloud.key && e.acrcloud.secret),
    acoustid:  !!e.acoustid,
    replicate: !!e.replicate,
    discogs:   !!e.discogs,
    lastfm:    !!e.lastfm,
  };
}

// ─────────────────────────────────────────────────────────────────
// Cascata user → env → embedded per ogni chiave specifica
// ─────────────────────────────────────────────────────────────────

/** ACRCloud: ritorna { host, key, secret } merge delle 3 sorgenti. */
function pickAcrCredentials(userCreds = {}, { includeEnv = true } = {}) {
  const embedded = getEmbeddedKeys().acrcloud;
  const env = includeEnv ? {
    host:   process.env.ACR_HOST   || process.env.ACRCLOUD_HOST || '',
    key:    process.env.ACR_KEY    || process.env.ACRCLOUD_ACCESS_KEY || '',
    secret: process.env.ACR_SECRET || process.env.ACRCLOUD_ACCESS_SECRET || '',
  } : { host: '', key: '', secret: '' };
  const u = userCreds || {};
  return {
    host:   String(u.host   || u.ACR_HOST   || env.host   || embedded.host   || '').trim(),
    key:    String(u.key    || u.accessKey  || u.ACR_KEY  || env.key    || embedded.key    || '').trim(),
    secret: String(u.secret || u.accessSecret || u.ACR_SECRET || env.secret || embedded.secret || '').trim(),
  };
}

function pickAcoustidKey(userKey = '') {
  return String(
    userKey ||
    process.env.ACOUSTID_KEY ||
    getEmbeddedKeys().acoustid ||
    ''
  ).trim();
}

function pickReplicateToken(userToken = '') {
  return String(
    userToken ||
    process.env.REPLICATE_TOKEN ||
    getEmbeddedKeys().replicate ||
    ''
  ).trim();
}

function pickDiscogsToken(userToken = '') {
  return String(
    userToken ||
    process.env.DISCOGS_TOKEN ||
    getEmbeddedKeys().discogs ||
    ''
  ).trim();
}

function pickLastfmKey(userKey = '') {
  return String(
    userKey ||
    process.env.LASTFM_KEY ||
    getEmbeddedKeys().lastfm ||
    ''
  ).trim();
}

module.exports = {
  getEmbeddedKeys,
  hasAnyEmbeddedKey,
  getEmbeddedKeyFlags,
  pickAcrCredentials,
  pickAcoustidKey,
  pickReplicateToken,
  pickDiscogsToken,
  pickLastfmKey,
};
