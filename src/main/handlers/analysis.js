/**
 * src/main/handlers/analysis.js
 *
 * Handler: analysis:start, library:analyzeFull (legacy), library:analyze (legacy),
 *          library:scan, library:scanFiles.
 */

'use strict';

const path = require('path');

const metadataService = require('../../services/metadataService');
const fingerprintService = require('../../services/fingerprintService');
const bpmService = require('../../services/bpmService');
const keyService = require('../../services/keyService');
const acrcloudService = require('../../services/acrcloudService');
const aiGenreService = require('../../services/aiGenreService');
const artworkService = require('../../services/artworkService');
const genreClassifier = require('../../services/genreClassifierService');
const duplicateService = require('../../services/duplicateService');
const renameService = require('../../services/renameService');
const organizerService = require('../../services/organizerService');
const analysisQueue = require('../../services/analysisQueue');
const analysisCache = require('../../services/analysisCache');
const { CONFIG } = require('../../constants/CONFIG');

function register(ctx) {
  const {
    ipcMain, store, appState,
    send, emitLog, emitAnalysisProgress,
    ok, fail, pct, validateOutputPath,
  } = ctx;

  // ── Scan legacy + helper per drop/multi-pick ─────────────────────
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
      const seen = new Set(appState.loadedTracks.map(t => t.filePath));
      for (const t of tracks) if (!seen.has(t.filePath)) appState.loadedTracks.push(t);
      return ok(tracks);
    } catch (e) { return fail(e); }
  });

  // ── PIPELINE: analysis:start (4 fasi + post-analisi) ─────────────
  ipcMain.handle('analysis:start', async (_e, sourceFolder) => {
    if (appState.analysisRunning) {
      return fail(new Error('Analisi già in corso'));
    }
    const folder = sourceFolder || appState.sourceFolder;
    const vErr = validateOutputPath(folder);
    if (vErr) {
      emitLog('error', '❌', `Analisi rifiutata: ${vErr}`);
      return fail(new Error(vErr));
    }
    appState.analysisRunning = true;
    appState.sourceFolder = folder;

    try {
      const c = store.get('analysisConcurrency', 3);
      analysisQueue.setConcurrency(c);
    } catch { /* noop */ }

    // clear() ora è async e aspetta onIdle se ci sono task in-flight
    // prima di resettare i contatori (no progress callback zombie).
    await analysisQueue.clear();
    analysisQueue.setProgressCallback(({ completed, total, pending }) => {
      send('analysis:queue-progress', { completed, total, pending });
    });

    try {
      try { analysisCache.initCache(appState.sourceFolder); }
      catch (err) { emitLog('warn', '⚠️', `Cache init: ${err.message}`); }
      analysisCache.pauseSaves();

      // FASE 1 — metadati
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

      // FASE 2 — fingerprint
      emitAnalysisProgress({ phase: 2, phaseProgress: 0, phaseLabel: 'Fingerprint acustico (Chromaprint)...' });
      await fingerprintService.fingerprintAll(tracks, (done, total, t) => {
        emitAnalysisProgress({
          phase: 2, phaseProgress: Math.round(pct(done, total) / 2),
          phaseLabel: 'Fingerprint acustico (Chromaprint)...',
          currentFile: t?.fileName,
        });
      });

      // FASE 2B — BPM + Key
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
      for (const t of tracks) {
        if (t.bpmDetected || t.keyDetected) {
          try { await metadataService.writeAnalysisTags(t); }
          catch (e) { console.warn('[id3 tags]', t.fileName, e.message); }
        }
      }
      emitAnalysisProgress({ phase: 2, phaseProgress: 100, phaseLabel: 'Fingerprint + BPM + Key completati' });

      // FASE 2C — AI genre
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

      // FASE 3 — ACRCloud
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

      // FASE 3C — Cover art
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
            let okArt = false;
            if (t.coverArtUrl && typeof artworkService.fetchCoverArtFromShazam === 'function') {
              okArt = await artworkService.fetchCoverArtFromShazam(t);
            }
            if (!okArt && t.mbid) {
              okArt = await artworkService.fetchCoverArt(t);
            }
            if (okArt) addedArt++;
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

      // FASE 4 — classificazione
      emitAnalysisProgress({ phase: 4, phaseProgress: 0, phaseLabel: 'Classificazione genere e lingua...' });
      const { resolveFolder } = require('../../constants/FOLDER_STRUCTURE');
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const cls = await genreClassifier.classify(t);
        t.detectedGenre = cls.genre;
        t.vocalsLanguage = cls.language;
        t.classificationConfidence = cls.confidence;
        t.classificationSource = cls.source;

        try {
          const d = cls.details || {};
          const destFolder = resolveFolder(t);
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

      // Post-analisi
      appState.duplicateReport = duplicateService.findDuplicates(tracks);
      appState.renamePreview = await renameService.previewRenames(tracks);
      appState.organizePreview = await organizerService.previewOrganization(tracks, appState.sourceFolder);

      try {
        appState.crossMixDuplicates = await duplicateService.findCrossMixDuplicates(tracks);
        if (appState.crossMixDuplicates.length > 0) {
          emitLog('warn', '🔁', `${appState.crossMixDuplicates.length} canzoni presenti in più mix`);
        }
        send('analysis:cross-mix-duplicates', { duplicates: appState.crossMixDuplicates });
      } catch (err) {
        emitLog('warn', '⚠️', `Cross-mix check fallito: ${err.message}`);
      }

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
      try { analysisCache.resumeSaves(); } catch { /* noop */ }
    }
  });

  // ── Legacy: library:analyzeFull (tracks già caricati) ────────────
  ipcMain.handle('library:analyzeFull', async (_e, tracks) => {
    try {
      appState.loadedTracks = tracks || [];
      appState.analysisRunning = true;
      try {
        const list = appState.loadedTracks;
        await fingerprintService.fingerprintAll(list, (done, total, t) => {
          emitAnalysisProgress({
            phase: 2, phaseProgress: pct(done, total),
            phaseLabel: 'Fingerprint acustico (Chromaprint)...', currentFile: t?.fileName,
          });
        });
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          try { await bpmService.detectBpmIfMissing(t); }
          catch (e) { emitLog('warn', '⚠️', `[bpm] ${t.fileName}: ${e.message}`); }
          try { await keyService.detectKeyIfMissing(t); }
          catch (e) { emitLog('warn', '⚠️', `[key] ${t.fileName}: ${e.message}`); }
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

  // ── Legacy: library:analyze (solo fingerprint + classify) ────────
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
}

module.exports = { register };
