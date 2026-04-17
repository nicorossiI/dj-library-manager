/**
 * src/services/analysisCache.js
 *
 * Cache persistente per fingerprint/BPM/key invalidata da mtime+size del file.
 * File: <sourceFolder>/.djlm_cache.json
 *
 * API:
 *   initCache(sourceFolder)   → carica o crea; scarta entries con version diversa
 *   getCached(filePath)       → entry valida | null (se file modificato o assente)
 *   setCached(filePath, data) → MERGE parziale (fingerprint + bpm + key arrivano
 *                               da chiamate diverse; non sovrascrivere)
 *   saveCache()               → flush JSON pretty-printed
 *
 * Resilienza: try/catch ovunque. Se il cache file non è scrivibile/leggibile
 * la pipeline continua senza cache (degrado silenzioso).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_VERSION = '1.1';
const CACHE_FILENAME = '.djlm_cache.json';

let cacheData = null;
let cachePath = null;

function initCache(sourceFolder) {
  cacheData = { version: CACHE_VERSION, entries: {} };
  cachePath = null;
  if (!sourceFolder) return;
  try {
    cachePath = path.join(sourceFolder, CACHE_FILENAME);
    if (fs.existsSync(cachePath)) {
      const raw = fs.readFileSync(cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === CACHE_VERSION && parsed.entries) {
        cacheData = parsed;
        console.log('[CACHE] Caricata:', Object.keys(parsed.entries).length, 'entries');
        return;
      }
      console.log('[CACHE] Version mismatch, entries scartate');
    }
  } catch (err) {
    console.warn('[CACHE] Lettura fallita:', err.message);
    cacheData = { version: CACHE_VERSION, entries: {} };
  }
}

function getCached(filePath) {
  if (!cacheData || !filePath) return null;
  const entry = cacheData.entries[filePath];
  if (!entry) return null;
  try {
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs === entry.mtime && stat.size === entry.size) {
      return entry;
    }
  } catch { /* file sparito */ }
  return null;
}

function setCached(filePath, data) {
  if (!cacheData || !filePath || !data) return;
  try {
    const stat = fs.statSync(filePath);
    const prev = cacheData.entries[filePath] || {};
    // Merge: nuove entry non sovrascrivono le chiavi esistenti non presenti nel partial.
    cacheData.entries[filePath] = {
      ...prev,
      ...data,
      mtime: stat.mtimeMs,
      size: stat.size,
      cachedAt: new Date().toISOString(),
    };
  } catch { /* file sparito */ }
}

function saveCache() {
  if (!cacheData || !cachePath) return;
  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), 'utf8');
    console.log('[CACHE] Salvata:', Object.keys(cacheData.entries).length, 'entries →', cachePath);
  } catch (err) {
    console.warn('[CACHE] Salvataggio fallito:', err.message);
  }
}

function _resetForTests() {
  cacheData = null;
  cachePath = null;
}

module.exports = {
  initCache,
  getCached,
  setCached,
  saveCache,
  CACHE_VERSION,
  _resetForTests,
};
