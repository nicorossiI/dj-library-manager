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

// Lock: se un'altra scrittura sta accadendo (o un'analisi lunga è in corso),
// deferisci e coalesci. Previene il "last-writer-wins" che corrompe la cache.
let _writeInFlight = false;
let _pendingWrite = false;
let _savePaused = false;

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

// Merge disk copy + in-memory, write atomicamente via tmp+rename.
// Previene race quando due write si accavallano: l'ultima re-legge lo stato
// fresco da disco prima di fondere, quindi non sovrascrive entry di altri
// processi/analisi parallele.
function _doSave() {
  if (!cacheData || !cachePath) return;
  try {
    let onDisk = { version: CACHE_VERSION, entries: {} };
    if (fs.existsSync(cachePath)) {
      try {
        const raw = fs.readFileSync(cachePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === CACHE_VERSION && parsed.entries) {
          onDisk = parsed;
        }
      } catch { /* disk corrotto: ignora, sovrascrivi */ }
    }
    // In-memory ha PRIORITÀ sulle chiavi presenti; disk fornisce entry di altre analisi.
    const merged = {
      version: CACHE_VERSION,
      entries: { ...onDisk.entries, ...cacheData.entries },
    };
    // Aggiorna in-memory con il merge completo così le letture seguenti vedono tutto
    cacheData = merged;

    const tmp = cachePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(tmp, cachePath);
    console.log('[CACHE] Salvata:', Object.keys(merged.entries).length, 'entries →', cachePath);
  } catch (err) {
    console.warn('[CACHE] Salvataggio fallito:', err.message);
  }
}

function saveCache() {
  if (!cacheData || !cachePath) return;
  // Pausa esplicita (es. analisi lunga in corso): deferisci al resume.
  if (_savePaused) { _pendingWrite = true; return; }
  // Coalesce: se una write è già in corso, segnala che serve un'altra passata.
  if (_writeInFlight) { _pendingWrite = true; return; }
  _writeInFlight = true;
  try {
    _doSave();
  } finally {
    _writeInFlight = false;
    if (_pendingWrite) {
      _pendingWrite = false;
      saveCache(); // flush pending
    }
  }
}

/**
 * Pausa le scritture finché resumeSaves() non viene chiamato.
 * Usato da ipcHandlers all'inizio/fine di analysis:start per evitare che
 * scritture intermedie (watcher, progress callbacks) si accavallino con
 * il flush finale della pipeline principale.
 */
function pauseSaves()  { _savePaused = true; }
function resumeSaves() {
  _savePaused = false;
  if (_pendingWrite) {
    _pendingWrite = false;
    saveCache();
  }
}

function _resetForTests() {
  cacheData = null;
  cachePath = null;
  _writeInFlight = false;
  _pendingWrite = false;
  _savePaused = false;
}

module.exports = {
  initCache,
  getCached,
  setCached,
  saveCache,
  pauseSaves,
  resumeSaves,
  CACHE_VERSION,
  _resetForTests,
};
