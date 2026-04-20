/**
 * src/main/handlers/watcher.js
 *
 * Handler: watcher:start/stop/status.
 * Pipeline silenziosa per ogni nuovo file: metadata → fingerprint → BPM/key
 * → ACR/MB → classify. Accodato su analysisQueue per rispettare concorrenza.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const metadataService = require('../../services/metadataService');
const fingerprintService = require('../../services/fingerprintService');
const bpmService = require('../../services/bpmService');
const keyService = require('../../services/keyService');
const acrcloudService = require('../../services/acrcloudService');
const genreClassifier = require('../../services/genreClassifierService');
const analysisCache = require('../../services/analysisCache');
const analysisQueue = require('../../services/analysisQueue');
const watcherService = require('../../services/watcherService');
const { humanize } = require('../../utils/errorMessages');

function register(ctx) {
  const { ipcMain, store, ok, fail, emitLog } = ctx;

  async function processNewFile(filePath, senderOrNull) {
    const fname = path.basename(filePath);
    try {
      const track = await metadataService.readTrack(filePath);
      try { await fingerprintService.fingerprintTrack(track); }
      catch (e) { emitLog('warn', '⚠️', `[fp] ${fname}: ${e.message}`); }
      try { await bpmService.detectBpmIfMissing(track); }
      catch (e) { emitLog('warn', '⚠️', `[bpm] ${fname}: ${e.message}`); }
      try { await keyService.detectKeyIfMissing(track); }
      catch (e) { emitLog('warn', '⚠️', `[key] ${fname}: ${e.message}`); }
      try { await acrcloudService.recognizeSingleTrack(track); }
      catch (e) { emitLog('warn', '⚠️', `[acr] ${fname}: ${e.message}`); }
      try {
        const cls = await genreClassifier.classify(track);
        track.detectedGenre = cls.genre;
        track.vocalsLanguage = cls.language;
        track.classificationConfidence = cls.confidence;
        track.classificationSource = cls.source;
      } catch (e) { emitLog('warn', '⚠️', `[classify] ${fname}: ${e.message}`); }

      try { analysisCache.saveCache(); }
      catch (e) { console.warn('[Watcher cache]', e.message); }
      emitLog('success', '🎵', `Watcher: ${fname} → ${track.recognizedArtist || track.localArtist || '?'} - ${track.recognizedTitle || track.localTitle || '?'}`);
      if (senderOrNull) senderOrNull.send('watcher:file-processed', { track });
    } catch (err) {
      const human = humanize(err);
      emitLog('error', '❌', `Watcher: ${fname} — ${human}`);
      if (senderOrNull) senderOrNull.send('watcher:file-error', { filePath, error: human });
    }
  }

  ipcMain.handle('watcher:start', async (event, payload = {}) => {
    try {
      const folder = payload.folder || store.get('watchFolder');
      if (!folder) throw new Error('Cartella da monitorare non specificata');
      if (!fs.existsSync(folder)) throw new Error(`Cartella non esiste: ${folder}`);
      analysisCache.initCache(folder);
      const sender = event?.sender || null;
      watcherService.start(folder, (filePath) => {
        analysisQueue.enqueue(
          () => processNewFile(filePath, sender),
          path.basename(filePath),
        ).catch(err => {
          emitLog('error', '❌', `Watcher queue: ${path.basename(filePath)} — ${err?.message}`);
        });
      });
      store.set('watchFolder', folder);
      store.set('watcherActive', true);
      emitLog('info', '👁️', `Watcher attivo su ${folder} (concorrenza ${analysisQueue.getStats().concurrency})`);
      return ok({ folder, active: true });
    } catch (e) {
      return fail(new Error(humanize(e)));
    }
  });

  ipcMain.handle('watcher:stop', async () => {
    try {
      watcherService.stop();
      store.set('watcherActive', false);
      emitLog('info', '🛑', 'Watcher fermato');
      return ok({ active: false });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('watcher:status', async () => {
    return ok({
      active: watcherService.isActive(),
      folder: watcherService.currentFolder(),
    });
  });
}

module.exports = { register };
