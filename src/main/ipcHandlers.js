/**
 * src/main/ipcHandlers.js
 *
 * Pipeline orchestrata + stato globale main process.
 *
 * STATO (appState):
 *   sourceFolder      cartella scelta dall'utente
 *   loadedTracks      Track[] da scan + analisi (mutati in-place)
 *   organizedTracks   Track[] post-copia (newFilePath dentro DJ Library Organizzata)
 *   outputRoot        path assoluto cartella output
 *   analysisRunning   lock anti-rientranza
 *   duplicateReport   risultato findDuplicates
 *   renamePreview     anteprima rinomina
 *   organizePreview   { outputRoot, tree, stats }
 *   rekordboxXmlPath  path file XML generato
 *
 * CANALI principali (kebab-case spec):
 *   analysis:start, analysis:progress (push), analysis:complete (push)
 *   organize:preview, organize:execute, organize:progress (push), organize:complete (push)
 *   rekordbox:preview, rekordbox:generate-xml, rekordbox:xml-complete (push)
 *   config:get, config:set, config:test-api
 *   shell:open-folder, shell:open-file, shell:copy-text
 *
 * CANALI legacy (mantenuti per il preload attuale):
 *   dialog:selectFolder, files:selectFiles, settings:get/set, library:scan,
 *   library:scanFiles, library:analyzeFull, library:findDuplicates,
 *   library:rename, library:executeRename, library:previewOrganization,
 *   library:executeOrganization, library:exportRekordbox, library:organize,
 *   fingerprint:compute, acrcloud:identify, acrcloud:identifyMix,
 *   shell:openFolder, shell:openFile, shell:copyText, config:testApi
 *
 * Esporta: registerIpcHandlers({ store, getMainWindow }), getAppState()
 */

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { ipcMain, dialog, shell, clipboard, app } = require('electron');

const metadataService = require('../services/metadataService');
const fingerprintService = require('../services/fingerprintService');
const acrcloudService = require('../services/acrcloudService');
const shazamService = require('../services/shazamService');
const aiGenreService = require('../services/aiGenreService');
const analysisQueue = require('../services/analysisQueue');
const duplicateService = require('../services/duplicateService');
const renameService = require('../services/renameService');
const genreClassifier = require('../services/genreClassifierService');
const organizerService = require('../services/organizerService');
const rekordboxExportService = require('../services/rekordboxExportService');
const bpmService = require('../services/bpmService');
const keyService = require('../services/keyService');
const analysisCache = require('../services/analysisCache');
const libraryUpdateService = require('../services/libraryUpdateService');
const artworkService = require('../services/artworkService');
const watcherService = require('../services/watcherService');
const { humanize } = require('../utils/errorMessages');
const { CONFIG } = require('../constants/CONFIG');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const appState = {
  sourceFolder: null,
  loadedTracks: [],
  organizedTracks: [],
  outputRoot: null,
  analysisRunning: false,
  duplicateReport: null,
  crossMixDuplicates: [],
  renamePreview: [],
  organizePreview: null,
  rekordboxXmlPath: null,
};

function getAppState() { return appState; }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ok = (data) => ({ ok: true, data });
const fail = (err) => ({ ok: false, error: String(err?.message || err) });

function pct(done, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function makeSendEvent(getMainWindow) {
  return (channel, payload) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
}

// ---------------------------------------------------------------------------
// registerIpcHandlers
// ---------------------------------------------------------------------------

function registerIpcHandlers({ store, getMainWindow }) {
  const send = makeSendEvent(getMainWindow);

  // Push helper specifico per la pipeline analisi (overallPercent calcolato)
  function emitAnalysisProgress({ phase, phaseProgress, phaseLabel, currentFile }) {
    const totalPhases = 4;
    const overallPercent = Math.min(100, Math.round(((phase - 1) * 25) + (phaseProgress * 0.25)));
    send('analysis:progress', {
      phase, totalPhases, phaseProgress, phaseLabel, currentFile, overallPercent,
    });
    // Compat: anche eventi 'library:progress' per il renderer attuale
    send('library:progress', {
      phase: ['', 'metadata', 'fingerprint', 'acr', 'classify'][phase] || 'phase',
      done: phaseProgress, total: 100,
      label: phaseLabel, current: currentFile,
    });
  }

  function emitLog(level, icon, message) {
    send('library:log', { level, icon, message, ts: Date.now() });
  }

  // ─────────────────────────────────────────────────────────────────
  // Settings (legacy — usate da preload.getSettings/setSettings)
  // ─────────────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', async () => {
    try {
      const full = { ...store.store };
      // Flag runtime: login-item settings di Windows
      try {
        if (process.platform === 'win32') {
          full.startWithWindows = !!app.getLoginItemSettings().openAtLogin;
        } else {
          full.startWithWindows = false;
        }
      } catch { full.startWithWindows = false; }
      // Default notificationsEnabled (true se mai impostato)
      if (full.notificationsEnabled === undefined) full.notificationsEnabled = true;
      return ok(full);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('settings:set', async (_e, partial) => {
    try {
      const p = partial || {};
      for (const [k, v] of Object.entries(p)) {
        if (k === 'startWithWindows') continue; // gestito a parte
        store.set(k, v);
      }
      if ('startWithWindows' in p && process.platform === 'win32') {
        app.setLoginItemSettings({
          openAtLogin: !!p.startWithWindows,
          openAsHidden: true,
        });
      }
      if ('replicateToken' in p) {
        try { aiGenreService.setReplicateToken(p.replicateToken || ''); } catch { /* noop */ }
      }
      if ('analysisConcurrency' in p) {
        try { analysisQueue.setConcurrency(p.analysisConcurrency); } catch { /* noop */ }
      }
      if ('acoustidKey' in p) {
        try {
          const mbService = require('../services/musicbrainzService');
          if (mbService.setAcoustidKey) mbService.setAcoustidKey(p.acoustidKey || '');
        } catch { /* noop */ }
      }
      const acr = store.get('acrcloud') || {};
      acrcloudService.setCredentials(acr);
      return ok(store.store);
    } catch (e) { return fail(e); }
  });

  // Granular config:get / config:set (spec)
  ipcMain.handle('config:get', async (_e, key) => {
    try { return ok(key ? store.get(key) : store.store); } catch (e) { return fail(e); }
  });
  ipcMain.handle('config:set', async (_e, key, value) => {
    try {
      store.set(key, value);
      // Se l'utente ha cambiato credenziali ACRCloud, propaga
      if (typeof key === 'string' && (key.startsWith('acr') || key === 'acrcloud')) {
        const acr = store.get('acrcloud') || {};
        acrcloudService.setCredentials(acr);
      }
      return ok(true);
    } catch (e) { return fail(e); }
  });

  // Boot: propaga subito le credenziali salvate
  try {
    const acr = store.get('acrcloud') || {};
    acrcloudService.setCredentials(acr);
  } catch { /* noop */ }
  try {
    const rt = store.get('replicateToken', '');
    if (rt) aiGenreService.setReplicateToken(rt);
  } catch (err) { console.warn('[boot] replicateToken:', err.message); }
  try {
    const c = store.get('analysisConcurrency', 3);
    analysisQueue.setConcurrency(c);
  } catch (err) { console.warn('[boot] analysisConcurrency:', err.message); }
  try {
    const mbService = require('../services/musicbrainzService');
    if (mbService.initFromStore) mbService.initFromStore(store);
  } catch (err) { console.warn('[boot] musicbrainz init:', err.message); }

  // ─────────────────────────────────────────────────────────────────
  // Folder / files picker
  // ─────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────
  // Watcher — monitora una cartella e processa i nuovi file audio.
  // Pipeline silenziosa: metadata → fingerprint → BPM/key → ACR/MB →
  // classify → rename. Niente organizzazione automatica (richiederebbe
  // outputRoot fisso — fuori scope di questo handler base).
  // ─────────────────────────────────────────────────────────────────

  async function _processNewFile(filePath, senderOrNull) {
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
      // Ogni `add` event viene accodato sulla queue condivisa (max N concorrenze).
      // Essenziale per bulk-add di 50+ file senza saturare Shazam/ACR rate-limit.
      watcherService.start(folder, (filePath) => {
        analysisQueue.enqueue(
          () => _processNewFile(filePath, sender),
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

  ipcMain.handle('dialog:selectFolder', async () => {
    try {
      const win = getMainWindow();
      const r = await dialog.showOpenDialog(win, {
        title: 'Seleziona cartella libreria musicale',
        properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return ok(null);
      store.set('ui.lastFolder', r.filePaths[0]);
      appState.sourceFolder = r.filePaths[0];
      return ok(r.filePaths[0]);
    } catch (e) { return fail(e); }
  });

  // Picker dedicato alla "libreria esistente" (modalità update)
  ipcMain.handle('dialog:selectExistingLibrary', async () => {
    try {
      const win = getMainWindow();
      const r = await dialog.showOpenDialog(win, {
        title: 'Seleziona cartella "DJ Library Organizzata" esistente',
        properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return ok(null);
      const chosen = r.filePaths[0];
      const cachePath = path.join(chosen, '.djlm_cache.json');
      if (!fs.existsSync(cachePath)) {
        return fail(new Error('La cartella selezionata non contiene .djlm_cache.json. Eseguire prima un\'analisi completa.'));
      }
      store.set('ui.lastExistingLibrary', chosen);
      return ok(chosen);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('files:selectFiles', async () => {
    try {
      const win = getMainWindow();
      const r = await dialog.showOpenDialog(win, {
        title: 'Seleziona file audio',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a'] }],
      });
      if (r.canceled || !r.filePaths.length) return ok([]);
      return ok(r.filePaths);
    } catch (e) { return fail(e); }
  });

  // ─────────────────────────────────────────────────────────────────
  // Scan (legacy + helper per drop/multi-pick)
  // ─────────────────────────────────────────────────────────────────
  ipcMain.handle('library:scan', async (_e, folder) => {
    try {
      if (!folder) throw new Error('Cartella non specificata');
      appState.sourceFolder = folder;
      const tracks = await metadataService.scanFolder(folder, true, (done, total, current) => {
        send('library:progress', { done, total, current, phase: 'scan' });
      });
      appState.loadedTracks = tracks;
      return ok(tracks);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('library:scanFiles', async (_e, filePaths) => {
    try {
      const list = Array.isArray(filePaths) ? filePaths : [];
      const tracks = [];
      for (let i = 0; i < list.length; i++) {
        const fp = list[i];
        send('library:progress', {
          done: i, total: list.length, current: path.basename(fp), phase: 'scan',
        });
        try {
          const t = await metadataService.readTrack(fp);
          if (t.duration && t.duration < (CONFIG.minTrackDurationSec || 30)) continue;
          tracks.push(t);
        } catch { /* skip */ }
      }
      // Fonde con loadedTracks esistenti
      const seen = new Set(appState.loadedTracks.map(t => t.filePath));
      for (const t of tracks) if (!seen.has(t.filePath)) appState.loadedTracks.push(t);
      return ok(tracks);
    } catch (e) { return fail(e); }
  });

  // ─────────────────────────────────────────────────────────────────
  // PIPELINE: analysis:start (4 fasi + post-analisi)
  // ─────────────────────────────────────────────────────────────────
  ipcMain.handle('analysis:start', async (_e, sourceFolder) => {
    if (appState.analysisRunning) {
      return fail(new Error('Analisi già in corso'));
    }
    appState.analysisRunning = true;
    appState.sourceFolder = sourceFolder || appState.sourceFolder;

    // Applica preset concurrency se impostato
    try {
      const c = store.get('analysisConcurrency', 3);
      analysisQueue.setConcurrency(c);
    } catch { /* noop */ }

    // Progress del pool → push al renderer per stats barra analisi
    analysisQueue.clear();
    analysisQueue.setProgressCallback(({ completed, total, pending }) => {
      send('analysis:queue-progress', { completed, total, pending });
    });

    try {
      // ── Cache persistente (fingerprint/bpm/key) ──────────────────
      try { analysisCache.initCache(appState.sourceFolder); }
      catch (err) { emitLog('warn', '⚠️', `Cache init: ${err.message}`); }

      // ── FASE 1 — Lettura metadati ────────────────────────────────
      emitAnalysisProgress({ phase: 1, phaseProgress: 0, phaseLabel: 'Lettura metadati...' });
      const tracks = await metadataService.scanFolder(
        appState.sourceFolder, true,
        (done, total, current) => emitAnalysisProgress({
          phase: 1, phaseProgress: pct(done, total),
          phaseLabel: 'Lettura metadati...', currentFile: current,
        }),
      );
      appState.loadedTracks = tracks;
      emitAnalysisProgress({ phase: 1, phaseProgress: 100, phaseLabel: 'Lettura metadati completata' });

      // ── FASE 2 — Fingerprint Chromaprint ─────────────────────────
      emitAnalysisProgress({ phase: 2, phaseProgress: 0, phaseLabel: 'Fingerprint acustico (Chromaprint)...' });
      await fingerprintService.fingerprintAll(tracks, (done, total, t) => {
        emitAnalysisProgress({
          phase: 2, phaseProgress: Math.round(pct(done, total) / 2),
          phaseLabel: 'Fingerprint acustico (Chromaprint)...',
          currentFile: t?.fileName,
        });
      });

      // ── FASE 2B — BPM + Key offline (music-tempo + essentia.js) ──
      emitAnalysisProgress({ phase: 2, phaseProgress: 50, phaseLabel: 'Calcolo BPM e chiave musicale...' });
      await bpmService.detectBpmAll(tracks, (done, total, t) => {
        emitAnalysisProgress({
          phase: 2, phaseProgress: 50 + Math.round(pct(done, total) / 4),
          phaseLabel: 'Calcolo BPM (music-tempo)...',
          currentFile: t?.fileName,
        });
      });
      await keyService.detectKeyAll(tracks, (done, total, t) => {
        emitAnalysisProgress({
          phase: 2, phaseProgress: 75 + Math.round(pct(done, total) / 4),
          phaseLabel: 'Calcolo chiave musicale (essentia.js)...',
          currentFile: t?.fileName,
        });
      });
      // Persisti BPM/Key nei tag ID3 (best-effort, solo .mp3)
      for (const t of tracks) {
        if (t.bpmDetected || t.keyDetected) {
          try { await metadataService.writeAnalysisTags(t); }
          catch (e) { console.warn('[id3 tags]', t.fileName, e.message); }
        }
      }
      emitAnalysisProgress({ phase: 2, phaseProgress: 100, phaseLabel: 'Fingerprint + BPM + Key completati' });

      // ── FASE 2C — AI genre (DiscogsEffNet) sulla BASE audio ──
      // Parallelizzato via p-queue: max N concorrenze (CONFIG.analysisConcurrency).
      // Serve a distinguere "afrohouse edit di una canzone reggaeton" dal
      // pezzo originale reggaeton. Popola track.aiGenre → priorità massima
      // nella cascata del genreClassifier.
      if (aiGenreService.isAvailable()) {
        emitAnalysisProgress({ phase: 2, phaseProgress: 100, phaseLabel: 'AI genre (DiscogsEffNet)...' });
        let doneAi = 0;
        const aiTasks = tracks.map(t => analysisQueue.enqueue(async () => {
          try {
            const ai = await aiGenreService.classifyGenreFromAudio(t);
            if (ai?.genre) {
              t.aiGenre = ai.genre;
              t.aiGenreConfidence = ai.confidence;
              t.aiTop = ai.top;
              emitLog('info', '🤖', `AI: ${t.fileName} → ${ai.genre} (${ai.confidence}%)`);
            }
          } catch (err) {
            emitLog('warn', '⚠️', `AI genre [${t.fileName}]: ${err?.message || err}`);
          } finally {
            doneAi++;
            emitAnalysisProgress({
              phase: 2, phaseProgress: 100,
              phaseLabel: `AI genre ${doneAi}/${tracks.length}`,
              currentFile: t.fileName,
            });
          }
        }, t.fileName));
        await Promise.allSettled(aiTasks);
      } else {
        emitLog('info', 'ℹ️', 'AI genre non disponibile (modello/Python mancanti) — skip');
      }

      // ── FASE 3 — ACRCloud (skippable se offline) ─────────────────
      if (acrcloudService.hasCredentials()) {
        emitAnalysisProgress({ phase: 3, phaseProgress: 0, phaseLabel: 'Riconoscimento ACRCloud...' });
        await acrcloudService.recognizeAll(tracks, (done, total, t) => {
          emitAnalysisProgress({
            phase: 3, phaseProgress: pct(done, total),
            phaseLabel: 'Riconoscimento ACRCloud...',
            currentFile: t?.fileName,
          });
          if (t?.isRecognized) {
            const src = t.recognitionSource || 'acrcloud';
            emitLog('success', '✓', `${t.fileName} → ${t.recognizedArtist} - ${t.recognizedTitle} [${t.recognitionConfidence}% · ${src}]`);
          } else if (t) {
            emitLog('warn', '⚠️', `${t.fileName} → non riconosciuto, uso metadati locali`);
          }
        });
      } else {
        emitLog('info', 'ℹ️', 'ACRCloud non disponibile, uso solo metadati locali');
        emitAnalysisProgress({ phase: 3, phaseProgress: 90, phaseLabel: 'ACRCloud skippato (offline)' });
      }

      // ── FASE 3C — Cover art parallelizzata via queue ──
      // Include tutti i track con mbid OPPURE coverArtUrl (da Shazam).
      // Prima fetchCoverArtAll era seriale con N+1 HTTP → con 1000 track
      // poteva arrivare a ore. Ora concorrenza N.
      const tracksForArt = tracks.filter(t => t && !t.artworkFetched && (t.mbid || t.coverArtUrl));
      if (tracksForArt.length > 0) {
        emitAnalysisProgress({
          phase: 3, phaseProgress: 90,
          phaseLabel: `Cover art per ${tracksForArt.length} track...`,
        });
        let addedArt = 0;
        let doneArt = 0;
        const artTasks = tracksForArt.map(t => analysisQueue.enqueue(async () => {
          try {
            // 1) Prova Shazam CDN se abbiamo URL (più veloce)
            let ok = false;
            if (t.coverArtUrl && typeof artworkService.fetchCoverArtFromShazam === 'function') {
              ok = await artworkService.fetchCoverArtFromShazam(t);
            }
            // 2) Fallback Cover Art Archive se mbid presente
            if (!ok && t.mbid) {
              ok = await artworkService.fetchCoverArt(t);
            }
            if (ok) addedArt++;
          } catch (err) {
            emitLog('warn', '⚠️', `Cover art [${t.fileName}]: ${err.message}`);
          } finally {
            doneArt++;
            emitAnalysisProgress({
              phase: 3, phaseProgress: 90 + Math.round((doneArt / tracksForArt.length) * 10),
              phaseLabel: 'Cover art...', currentFile: t.fileName,
            });
          }
        }, t.fileName));
        await Promise.allSettled(artTasks);
        if (addedArt > 0) emitLog('success', '🎨', `Cover art scaricate: ${addedArt}/${tracksForArt.length}`);
      }
      emitAnalysisProgress({ phase: 3, phaseProgress: 100, phaseLabel: 'Riconoscimento + cover art completati' });

      // ── FASE 4 — Classificazione (async: Discogs + Last.fm rate-limited) ─
      emitAnalysisProgress({ phase: 4, phaseProgress: 0, phaseLabel: 'Classificazione genere e lingua...' });
      const { resolveTargetFolder } = require('../constants/FOLDER_STRUCTURE');
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const cls = await genreClassifier.classify(t);
        t.detectedGenre = cls.genre;
        t.vocalsLanguage = cls.language;
        t.classificationConfidence = cls.confidence;
        t.classificationSource = cls.source;

        // Log dettagliato: Base · Vocals · Tipo · Cartella finale
        try {
          const d = cls.details || {};
          const destFolder = resolveTargetFolder(t);
          const confPct = Math.round((cls.confidence || 0) * 100);
          const vocalsInfo = d.vocalsArtists?.length
            ? d.vocalsArtists.slice(0, 3).join(', ')
            : (t.languageSource ? `via ${t.languageSource}` : '—');
          emitLog('info', '🎯',
            `${t.fileName}\n` +
            `   Base: ${cls.genre} [${cls.source} ${confPct}%]  ·  ` +
            `Vocals: ${cls.language} [${vocalsInfo}]  ·  ` +
            `Tipo: ${d.type || 'single'}  ·  BPM: ${t.bpm || '—'}\n` +
            `   → ${destFolder}`
          );
        } catch (e) {
          console.warn('[log classify]', t.fileName, e.message);
        }

        emitAnalysisProgress({
          phase: 4, phaseProgress: pct(i + 1, tracks.length),
          phaseLabel: 'Classificazione genere e lingua...',
          currentFile: t.fileName,
        });
      }

      // ── POST-ANALISI (calcoli rapidi, no progress) ───────────────
      appState.duplicateReport = duplicateService.findDuplicates(tracks);
      appState.renamePreview = await renameService.previewRenames(tracks);
      appState.organizePreview = await organizerService.previewOrganization(tracks, appState.sourceFolder);

      // ── CROSS-MIX DUPLICATES (verifica Chromaprint async, best-effort) ─
      try {
        appState.crossMixDuplicates = await duplicateService.findCrossMixDuplicates(tracks);
        if (appState.crossMixDuplicates.length > 0) {
          emitLog('warn', '🔁', `${appState.crossMixDuplicates.length} canzoni presenti in più mix`);
        }
        send('analysis:cross-mix-duplicates', { duplicates: appState.crossMixDuplicates });
      } catch (err) {
        emitLog('warn', '⚠️', `Cross-mix check fallito: ${err.message}`);
      }

      // ── Persisti cache su disco ──────────────────────────────────
      try { analysisCache.saveCache(); } catch { /* skip */ }

      const completePayload = {
        tracks: appState.loadedTracks,
        duplicateReport: appState.duplicateReport,
        crossMixDuplicates: appState.crossMixDuplicates || [],
        renamePreview: appState.renamePreview,
        organizePreview: appState.organizePreview,
        rekordboxPreview: appState.organizePreview?.tree || {},
      };
      send('analysis:complete', completePayload);
      emitLog('success', '✅', `Analisi completata: ${tracks.length} tracce`);

      return ok(completePayload);
    } catch (err) {
      emitLog('error', '❌', `Analisi fallita: ${err.message}`);
      return fail(err);
    } finally {
      appState.analysisRunning = false;
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Modalità "aggiungi a libreria esistente"
  // ─────────────────────────────────────────────────────────────────
  ipcMain.handle('library:update-existing', async (event, payload = {}) => {
    try {
      const { existingRoot } = payload;
      const newTracks = Array.isArray(payload.newTracks) && payload.newTracks.length > 0
        ? payload.newTracks
        : appState.loadedTracks;
      if (!existingRoot) throw new Error('existingRoot mancante');
      if (!newTracks || newTracks.length === 0) throw new Error('Nessuna traccia da aggiungere');

      // 1. Carica cache esistente
      const existingCache = await libraryUpdateService.loadExistingLibrary(existingRoot);
      emitLog('info', '📚', `Libreria esistente: ${Object.keys(existingCache.entries).length} entries`);

      // 2. Classifica nuove vs duplicate
      const { duplicates, newTracks: unique } =
        await libraryUpdateService.checkAgainstExisting(newTracks, existingCache);
      emitLog('info', '🔍', `${duplicates.length} già in libreria, ${unique.length} nuove`);

      // 3. Organizza le sole nuove (copia nei folder giusti all'interno di existingRoot)
      let organizeResult = null;
      if (unique.length > 0) {
        organizeResult = await organizerService.executeOrganization(
          unique, existingRoot,
          (done, total, fileName, folder) => {
            event.sender.send('library:update-progress', { done, total, file: fileName, folder });
          },
        );
      }

      // 4. Aggiorna rekordbox.xml se esiste (altrimenti skip — l'utente lo genererà a mano)
      const xmlPath = path.join(existingRoot, 'rekordbox.xml');
      let xmlResult = null;
      if (fs.existsSync(xmlPath) && unique.length > 0) {
        try {
          xmlResult = await libraryUpdateService.updateRekordboxXml(xmlPath, unique);
          emitLog('success', '✅', `rekordbox.xml aggiornato: +${xmlResult.added} tracce`);
        } catch (xerr) {
          emitLog('warn', '⚠️', `Aggiornamento rekordbox.xml fallito: ${xerr.message}`);
        }
      }

      return ok({
        duplicatesFound: duplicates.length,
        newTracksAdded: unique.length,
        duplicates,
        organizeResult,
        xmlUpdated: !!xmlResult,
        xmlPath: xmlResult ? xmlPath : null,
        existingRoot,
      });
    } catch (e) {
      emitLog('error', '❌', `Update libreria fallito: ${e.message}`);
      return fail(e);
    }
  });

  // Legacy: library:analyzeFull → ridiretto su analysis:start con tracks già caricati
  ipcMain.handle('library:analyzeFull', async (_e, tracks) => {
    try {
      // Fase 2-4 senza ri-scan (le tracks arrivano già dal renderer)
      appState.loadedTracks = tracks || [];
      appState.analysisRunning = true;
      try {
        const list = appState.loadedTracks;
        // Phase 2
        await fingerprintService.fingerprintAll(list, (done, total, t) => {
          emitAnalysisProgress({
            phase: 2, phaseProgress: pct(done, total),
            phaseLabel: 'Fingerprint acustico (Chromaprint)...', currentFile: t?.fileName,
          });
        });
        // Phase 2.5 — BPM + KEY (offline analysis)
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          try { await bpmService.detectBpmIfMissing(t); }
          catch (e) { emitLog('warn', '⚠️', `[bpm] ${t.fileName}: ${e.message}`); }
          try { await keyService.detectKeyIfMissing(t); }
          catch (e) { emitLog('warn', '⚠️', `[key] ${t.fileName}: ${e.message}`); }
          // Persisti i nuovi valori nei tag ID3 (best-effort, solo .mp3)
          if (t.bpmDetected || t.keyDetected) {
            try { await metadataService.writeAnalysisTags(t); }
            catch (e) { console.warn('[id3 tags]', t.fileName, e.message); }
          }
          emitAnalysisProgress({
            phase: 2, phaseProgress: pct(i + 1, list.length),
            phaseLabel: `BPM + Chiave (${t.bpm ? 'bpm' : '·'}/${t.key ? 'key' : '·'})...`,
            currentFile: t?.fileName,
          });
        }
        // Phase 3
        if (acrcloudService.hasCredentials()) {
          await acrcloudService.recognizeAll(list, (done, total, t) => {
            emitAnalysisProgress({
              phase: 3, phaseProgress: pct(done, total),
              phaseLabel: 'Riconoscimento ACRCloud...', currentFile: t?.fileName,
            });
          });
        } else {
          emitLog('info', 'ℹ️', 'ACRCloud non disponibile, uso solo metadati locali');
        }
        // Phase 4
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          const cls = await genreClassifier.classify(t);
          t.detectedGenre = cls.genre;
          t.vocalsLanguage = cls.language;
          t.classificationConfidence = cls.confidence;
          t.classificationSource = cls.source;
        }
        appState.duplicateReport = duplicateService.findDuplicates(list);
        appState.renamePreview = await renameService.previewRenames(list);
        if (appState.sourceFolder) {
          appState.organizePreview = await organizerService.previewOrganization(list, appState.sourceFolder);
        }
        try {
          appState.crossMixDuplicates = await duplicateService.findCrossMixDuplicates(list);
          if (appState.crossMixDuplicates.length > 0) {
            emitLog('warn', '🔁', `${appState.crossMixDuplicates.length} canzoni presenti in più mix`);
          }
          send('analysis:cross-mix-duplicates', { duplicates: appState.crossMixDuplicates });
        } catch (err) {
          emitLog('warn', '⚠️', `Cross-mix check fallito: ${err.message}`);
        }
        // Emit analysis:complete anche da questo path per uniformità API
        send('analysis:complete', {
          tracks: appState.loadedTracks,
          duplicateReport: appState.duplicateReport,
          crossMixDuplicates: appState.crossMixDuplicates || [],
          renamePreview: appState.renamePreview,
          organizePreview: appState.organizePreview,
          rekordboxPreview: appState.organizePreview?.tree || {},
        });
        return ok(list);
      } finally {
        appState.analysisRunning = false;
      }
    } catch (e) { return fail(e); }
  });

  // Legacy: library:analyze (solo fingerprint + classify, no ACRCloud)
  ipcMain.handle('library:analyze', async (_e, tracks) => {
    try {
      const minMixSec = (CONFIG.mix?.minDurationMinutes || 10) * 60;
      const out = [];
      for (const t of tracks || []) {
        try { await fingerprintService.fingerprintTrack(t); }
        catch (err) { t.errorMessage = `fingerprint: ${err.message}`; }
        const cls = await genreClassifier.classify(t);
        t.detectedGenre = cls.genre;
        t.vocalsLanguage = cls.language;
        t.classificationConfidence = cls.confidence;
        t.classificationSource = cls.source;
        t.isMix = (t.duration || 0) >= minMixSec;
        t.status = 'classified';
        out.push(t);
      }
      return ok(out);
    } catch (e) { return fail(e); }
  });

  // ─────────────────────────────────────────────────────────────────
  // Duplicates (legacy + nuovo)
  // ─────────────────────────────────────────────────────────────────
  ipcMain.handle('library:findDuplicates', async (_e, tracks) => {
    try {
      const list = tracks || appState.loadedTracks;
      const r = duplicateService.findDuplicates(list);
      appState.duplicateReport = r;
      return ok(r);
    } catch (e) { return fail(e); }
  });

  // Cross-mix duplicates: canzoni che compaiono in 2+ mix diversi
  ipcMain.handle('duplicates:cross-mix', async (_e, tracks) => {
    try {
      const list = tracks || appState.loadedTracks;
      const r = await duplicateService.findCrossMixDuplicates(list);
      appState.crossMixDuplicates = r;
      return ok(r);
    } catch (e) { return fail(e); }
  });

  // Auto-delete doppioni: sposta nel Cestino tutti i file non-recommended
  // dei gruppi di duplicati. Reversibile (shell.trashItem), non distruttivo.
  // Input: array di filePath da spostare nel cestino. Se vuoto, usa
  // appState.duplicateReport e sposta tutti i non-recommended.
  ipcMain.handle('duplicates:auto-delete', async (_e, filePaths = null) => {
    try {
      let paths = [];
      if (Array.isArray(filePaths) && filePaths.length > 0) {
        paths = filePaths.filter(Boolean);
      } else {
        const groups = appState.duplicateReport || [];
        for (const g of groups) {
          for (const it of (g.items || [])) {
            if (!it.recommended && it.filePath) paths.push(it.filePath);
          }
        }
      }

      const deleted = [];
      const errors = [];
      for (const p of paths) {
        try {
          if (!fs.existsSync(p)) continue;
          await shell.trashItem(p);
          deleted.push(p);
          // Rimuovi il track dallo state così non viene organizzato dopo
          const idx = appState.loadedTracks.findIndex(t => t.filePath === p);
          if (idx >= 0) appState.loadedTracks.splice(idx, 1);
        } catch (err) {
          errors.push({ path: p, error: String(err?.message || err) });
        }
      }
      emitLog('success', '🗑️', `Doppioni nel cestino: ${deleted.length}${errors.length ? ` (${errors.length} errori)` : ''}`);
      return ok({ deleted: deleted.length, errors });
    } catch (e) { return fail(e); }
  });

  // ─────────────────────────────────────────────────────────────────
  // Rename
  // ─────────────────────────────────────────────────────────────────
  ipcMain.handle('library:rename', async (_e, { tracks } = {}) => {
    try {
      const list = tracks || appState.loadedTracks;
      const r = await renameService.previewRenames(list);
      appState.renamePreview = r;
      return ok(r);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('library:executeRename', async (_e, { tracks, selectedIds, dryRun = false } = {}) => {
    try {
      const list = tracks || appState.loadedTracks;
      const res = await renameService.executeRenameAll(
        list, selectedIds || [], dryRun,
        (done, total, currentFileName) => {
          send('library:progress', {
            done, total, phase: 'rename', current: currentFileName,
          });
        },
      );
      return ok(res);
    } catch (e) { return fail(e); }
  });

  // ─────────────────────────────────────────────────────────────────
  // Organize: preview + execute (spec: organize:preview / organize:execute)
  // ─────────────────────────────────────────────────────────────────
  function getCustomOrganizeRoot() {
    try {
      const v = store.get('organizeOutputRoot', '');
      return (v && String(v).trim()) ? String(v).trim() : null;
    } catch { return null; }
  }

  async function doOrganizePreview({ tracks, sourceFolder } = {}) {
    const list = tracks || appState.loadedTracks;
    const folder = sourceFolder || appState.sourceFolder;
    if (!folder) throw new Error('sourceFolder mancante');
    const customRoot = getCustomOrganizeRoot();
    const r = await organizerService.previewOrganization(list, folder, { customRoot });
    appState.organizePreview = r;
    appState.outputRoot = r.outputRoot;
    return r;
  }

  async function doOrganizeExecute({ tracks, sourceFolder } = {}) {
    const list = tracks || appState.loadedTracks;
    const folder = sourceFolder || appState.sourceFolder;
    if (!folder) throw new Error('sourceFolder mancante');
    const customRoot = getCustomOrganizeRoot();
    const r = await organizerService.executeOrganization(
      list, folder,
      (done, total, fileName, targetFolder) => {
        const payload = {
          done, total, phase: 'organize',
          current: fileName, targetFolder,
        };
        send('organize:progress', payload);
        send('library:progress', payload);
      },
      { customRoot },
    );
    // CRUCIALE: i Track sono stati mutati in-place con newFilePath/rekordboxUri
    appState.organizedTracks = list;
    appState.outputRoot = r.outputRoot;
    send('organize:complete', { outputRoot: r.outputRoot, stats: {
      copied: r.copied, failed: r.failed, foldersCreated: r.foldersCreated,
    }});
    return r;
  }

  // Spec channels (kebab-case)
  ipcMain.handle('organize:preview', async (_e, payload) => {
    try { return ok(await doOrganizePreview(payload || {})); }
    catch (e) { return fail(e); }
  });
  ipcMain.handle('organize:execute', async (_e, payload) => {
    try { return ok(await doOrganizeExecute(payload || {})); }
    catch (e) { return fail(e); }
  });

  // Legacy aliases
  ipcMain.handle('library:previewOrganization', async (_e, payload) => {
    try { return ok(await doOrganizePreview(payload || {})); }
    catch (e) { return fail(e); }
  });
  ipcMain.handle('library:executeOrganization', async (_e, payload) => {
    try { return ok(await doOrganizeExecute(payload || {})); }
    catch (e) { return fail(e); }
  });

  // Legacy one-shot: organize + rekordbox.xml
  ipcMain.handle('library:organize', async (_e, { tracks, sourceRoot, mode = 'copy' } = {}) => {
    try {
      const res = await organizerService.organize(tracks || appState.loadedTracks, sourceRoot || appState.sourceFolder, {
        mode, writeRekordbox: true,
        onProgress: (p) => send('library:progress', p),
      });
      return ok(res.toJSON());
    } catch (e) { return fail(e); }
  });

  // ─────────────────────────────────────────────────────────────────
  // Rekordbox: preview + generate-xml
  // ─────────────────────────────────────────────────────────────────
  ipcMain.handle('rekordbox:preview', async () => {
    try {
      const tracks = appState.organizedTracks.length ? appState.organizedTracks : appState.loadedTracks;
      // Se abbiamo già un organizePreview con tree, usalo direttamente
      if (appState.organizePreview?.tree) {
        return ok({
          tree: appState.organizePreview.tree,
          stats: appState.organizePreview.stats,
          fromOrganized: appState.organizedTracks.length > 0,
        });
      }
      // Altrimenti raggruppa al volo
      const groups = rekordboxExportService.groupTracksByPlaylist(tracks);
      const tree = {};
      for (const [name, val] of groups.entries()) {
        if (val.direct) tree[name] = val.direct;
        else tree[name] = { ...val };
      }
      return ok({ tree, stats: null, fromOrganized: appState.organizedTracks.length > 0 });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('rekordbox:generate-xml', async () => {
    try {
      // CRUCIALE: usa organizedTracks se disponibili (path post-copia).
      const useOrganized = appState.organizedTracks.length > 0;
      const tracks = useOrganized ? appState.organizedTracks : appState.loadedTracks;
      if (!appState.outputRoot) throw new Error('outputRoot mancante (esegui organize:execute prima)');
      if (!useOrganized) {
        emitLog('warn', '⚠️', 'rekordbox.xml generato da loadedTracks (path non organizzati). Esegui prima organize:execute.');
      }
      const xmlPath = await rekordboxExportService.generateRekordboxXml(tracks, appState.outputRoot);
      appState.rekordboxXmlPath = xmlPath;
      const payload = { xmlPath, stats: { entries: tracks.length } };
      send('rekordbox:xml-complete', payload);
      emitLog('success', '✅', `rekordbox.xml: ${xmlPath}`);
      return ok(payload);
    } catch (e) { return fail(e); }
  });

  // Legacy alias
  ipcMain.handle('library:exportRekordbox', async (_e, { tracks, outputRoot } = {}) => {
    try {
      const t = (tracks && tracks.length) ? tracks
        : (appState.organizedTracks.length ? appState.organizedTracks : appState.loadedTracks);
      const root = outputRoot || appState.outputRoot;
      if (!root) throw new Error('outputRoot mancante');
      const xmlPath = await rekordboxExportService.generateRekordboxXml(t, root);
      appState.rekordboxXmlPath = xmlPath;
      return ok({ xmlPath, entries: t.length });
    } catch (e) { return fail(e); }
  });

  // ─────────────────────────────────────────────────────────────────
  // ACRCloud test connection (5s silenzio)
  // ─────────────────────────────────────────────────────────────────
  ipcMain.handle('config:test-api', async () => {
    try { return ok(await acrcloudService.testConnection({ seconds: 5 })); }
    catch (e) { return fail(e); }
  });

  // Shazam (gratuito, nessuna key): verifica solo che il modulo ESM carichi
  ipcMain.handle('shazam:test', async () => {
    try { return ok(await shazamService.testConnection()); }
    catch (e) { return fail(e); }
  });

  // Replicate API: verifica che il token sia valido (GET /v1/account)
  ipcMain.handle('replicate:test', async (_e, maybeToken) => {
    try {
      const axios = require('axios');
      const token = String(
        maybeToken || process.env.REPLICATE_TOKEN || store.get('replicateToken') || ''
      ).trim();
      if (!token) return ok({ ok: false, message: 'Token non configurato' });
      const r = await axios.get('https://api.replicate.com/v1/account', {
        headers: { 'Authorization': `Token ${token}` },
        timeout: 10_000,
        validateStatus: s => s < 500,
      });
      if (r.status === 200) {
        return ok({ ok: true, message: `Account: ${r.data?.username || 'valido'}` });
      }
      return ok({ ok: false, message: `Token non valido (${r.status})` });
    } catch (e) {
      return ok({ ok: false, message: `Errore: ${e.message}` });
    }
  });
  // Legacy alias
  ipcMain.handle('config:testApi', async () => {
    try {
      const r = await acrcloudService.testConnection({ seconds: 5 });
      // Mappa al formato vecchio { online, reason }
      return ok({ online: r.success, reason: r.error || null, responseTime: r.responseTime });
    } catch (e) { return fail(e); }
  });

  // ─────────────────────────────────────────────────────────────────
  // Shell helpers (kebab-case + camelCase legacy)
  // ─────────────────────────────────────────────────────────────────
  async function openPathSmart(p) {
    if (!p) throw new Error('path mancante');
    const stat = await fsp.stat(p).catch(() => null);
    const target = stat && stat.isFile() ? path.dirname(p) : p;
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  }

  ipcMain.handle('shell:open-folder', async (_e, p) => {
    try { await openPathSmart(p); return ok(true); } catch (e) { return fail(e); }
  });
  ipcMain.handle('shell:open-file', async (_e, p) => {
    try {
      if (!p) throw new Error('path mancante');
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
      return ok(true);
    } catch (e) { return fail(e); }
  });
  ipcMain.handle('shell:copy-text', async (_e, text) => {
    try { clipboard.writeText(String(text || '')); return ok(true); } catch (e) { return fail(e); }
  });

  // Legacy camelCase (usati dal preload attuale)
  ipcMain.handle('shell:openFolder', async (_e, p) => {
    try { await openPathSmart(p); return ok(true); } catch (e) { return fail(e); }
  });
  ipcMain.handle('shell:openFile', async (_e, p) => {
    try {
      if (!p) throw new Error('path mancante');
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
      return ok(true);
    } catch (e) { return fail(e); }
  });
  ipcMain.handle('shell:copyText', async (_e, text) => {
    try { clipboard.writeText(String(text || '')); return ok(true); } catch (e) { return fail(e); }
  });

  // ─────────────────────────────────────────────────────────────────
  // AcoustID — test chiave
  // ─────────────────────────────────────────────────────────────────
  ipcMain.handle('acoustid:test', async (_e, key) => {
    const k = String(key || '').trim();
    if (!k || k.length < 5) {
      return { ok: false, message: 'Chiave troppo corta' };
    }
    try {
      const axios = require('axios');
      // Test con fingerprint fake: AcoustID risponde 200 con status=error
      // (code 6 = invalid fingerprint, code 4 = invalid client key).
      const resp = await axios.get('https://api.acoustid.org/v2/lookup', {
        params: { client: k, duration: 30, fingerprint: 'AAAA', format: 'json' },
        timeout: 8000,
        validateStatus: () => true,
      });
      const data = resp.data || {};
      const errCode = data.status === 'error' ? data.error?.code : 0;
      if (errCode === 4) {
        return { ok: false, message: '🔴 Chiave non valida (client key rifiutata)' };
      }
      if (resp.status === 401 || resp.status === 403) {
        return { ok: false, message: '🔴 Chiave non valida' };
      }
      // Qualsiasi altra risposta (ok, code 6 invalid fingerprint, code 3 no results)
      // conferma che la key è accettata dal server.
      return { ok: true, message: '🟢 Chiave valida — AcoustID attivo' };
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        return { ok: false, message: '🔴 Chiave non valida' };
      }
      return { ok: false, message: `🔴 Errore connessione: ${err.message}` };
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Auto-updater
  // ─────────────────────────────────────────────────────────────────
  ipcMain.handle('update:install-now', () => {
    try { require('./updaterService').installNow(); return ok(true); }
    catch (e) { return fail(e); }
  });
  ipcMain.handle('update:check', () => {
    try { require('./updaterService').checkForUpdates(); return ok(true); }
    catch (e) { return fail(e); }
  });

  // ─────────────────────────────────────────────────────────────────
  // Low-level (legacy)
  // ─────────────────────────────────────────────────────────────────
  ipcMain.handle('fingerprint:compute', async (_e, filePath) => {
    try { return ok(await fingerprintService.computeFingerprint(filePath)); }
    catch (e) { return fail(e); }
  });
  ipcMain.handle('acrcloud:identify', async (_e, filePath) => {
    try { return ok(await acrcloudService.identifyFile(filePath)); }
    catch (e) { return fail(e); }
  });
  ipcMain.handle('acrcloud:identifyMix', async (_e, filePath) => {
    try { return ok(await acrcloudService.identifyMixSegments(filePath)); }
    catch (e) { return fail(e); }
  });
}

module.exports = { registerIpcHandlers, getAppState };
