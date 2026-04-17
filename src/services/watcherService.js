/**
 * src/services/watcherService.js
 *
 * Monitora una cartella per nuovi file audio (chokidar).
 * Quando appare un nuovo file supportato → chiama onNewFile(filePath).
 *
 * API:
 *   start(folderPath, onNewFile)  → avvia watcher (chiude quello esistente)
 *   stop()                         → chiude watcher
 *   isActive()                     → boolean
 *   currentFolder()                → path monitorato o null
 *
 * Dipendenze: chokidar, path
 */

'use strict';

const path = require('path');
const chokidar = require('chokidar');

const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.aiff', '.aif', '.wma']);

let _watcher = null;
let _folder = null;

function start(folderPath, onNewFile) {
  if (!folderPath) throw new Error('watcherService: folderPath mancante');
  if (_watcher) {
    try { _watcher.close(); } catch { /* noop */ }
    _watcher = null;
  }

  _watcher = chokidar.watch(folderPath, {
    ignored: /(^|[\/\\])\../,        // file/cartelle che iniziano con . (hidden)
    persistent: true,
    ignoreInitial: true,             // no trigger su file già presenti
    awaitWriteFinish: {
      stabilityThreshold: 3000,      // aspetta 3s che il download finisca
      pollInterval: 500,
    },
    depth: 3,                         // max 3 livelli di sottocartelle
  });

  _watcher.on('add', (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!AUDIO_EXT.has(ext)) return;
    try {
      if (typeof onNewFile === 'function') onNewFile(filePath);
    } catch { /* non far crashare il watcher */ }
  });

  _watcher.on('error', (err) => {
    // Log e continua — non distruggere il watcher
    try { console.warn('[watcher] error:', err?.message || err); } catch { /* noop */ }
  });

  _folder = folderPath;
  return _watcher;
}

function stop() {
  if (_watcher) {
    try { _watcher.close(); } catch { /* noop */ }
  }
  _watcher = null;
  _folder = null;
}

function isActive() {
  return _watcher !== null;
}

function currentFolder() {
  return _folder;
}

module.exports = { start, stop, isActive, currentFolder };
