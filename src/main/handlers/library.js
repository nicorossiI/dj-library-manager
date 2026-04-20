/**
 * src/main/handlers/library.js
 *
 * Handler: library:update-existing, library:findDuplicates, duplicates:cross-mix,
 *          duplicates:auto-delete, library:rename, library:executeRename,
 *          fingerprint:compute, acrcloud:identify, acrcloud:identifyMix.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

const duplicateService = require('../../services/duplicateService');
const renameService = require('../../services/renameService');
const organizerService = require('../../services/organizerService');
const libraryUpdateService = require('../../services/libraryUpdateService');
const fingerprintService = require('../../services/fingerprintService');
const acrcloudService = require('../../services/acrcloudService');
const { CONFIG } = require('../../constants/CONFIG');

function register(ctx) {
  const { ipcMain, appState, store, send, emitLog, ok, fail } = ctx;

  const DUP_CFG = CONFIG.duplicates || {};
  const TRASH_LOG_MAX = DUP_CFG.trashLogMax ?? 500;

  /**
   * Storico delle eliminazioni — serve per il bottone "📋 Storico" e per
   * l'undo manuale (recupero dal Cestino di Windows).
   * Ogni entry: { path, fileName, trashedAt, reason, keeperPath, matchType, score }
   */
  function appendTrashLog(entries) {
    try {
      const current = store.get('trashedFiles', []);
      const merged = [...current, ...entries].slice(-TRASH_LOG_MAX);
      store.set('trashedFiles', merged);
    } catch (err) {
      console.warn('[trash-log]', err.message);
    }
  }

  // ── library:update-existing (modalità "aggiungi a libreria esistente") ──
  ipcMain.handle('library:update-existing', async (event, payload = {}) => {
    try {
      const { existingRoot } = payload;
      const newTracks = Array.isArray(payload.newTracks) && payload.newTracks.length > 0
        ? payload.newTracks
        : appState.loadedTracks;
      if (!existingRoot) throw new Error('existingRoot mancante');
      if (!newTracks || newTracks.length === 0) throw new Error('Nessuna traccia da aggiungere');

      const existingCache = await libraryUpdateService.loadExistingLibrary(existingRoot);
      emitLog('info', '📚', `Libreria esistente: ${Object.keys(existingCache.entries).length} entries`);

      const { duplicates, newTracks: unique } =
        await libraryUpdateService.checkAgainstExisting(newTracks, existingCache);
      emitLog('info', '🔍', `${duplicates.length} già in libreria, ${unique.length} nuove`);

      let organizeResult = null;
      if (unique.length > 0) {
        organizeResult = await organizerService.executeOrganization(
          unique, existingRoot,
          (done, total, fileName, folder) => {
            event.sender.send('library:update-progress', { done, total, file: fileName, folder });
          },
        );
      }

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

  // ── Duplicates ───────────────────────────────────────────────────
  ipcMain.handle('library:findDuplicates', async (_e, tracks) => {
    try {
      const list = tracks || appState.loadedTracks;
      const r = duplicateService.findDuplicates(list);
      appState.duplicateReport = r;
      return ok(r);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('duplicates:cross-mix', async (_e, tracks) => {
    try {
      const list = tracks || appState.loadedTracks;
      const r = await duplicateService.findCrossMixDuplicates(list);
      appState.crossMixDuplicates = r;
      return ok(r);
    } catch (e) { return fail(e); }
  });

  /**
   * Cestina i file doppione con safety checks.
   *
   * Payload accettati:
   *   - `null` → usa `appState.duplicateReport` (tutti i non-recommended SICURI)
   *   - `string[]` → array di path (legacy)
   *   - `{ items: Array<{filePath, fileSize, keeperPath, matchType, score}> }`
   *     → nuovo formato con metadata per lo storico (preferito)
   *
   * Safeguard:
   *   - Non cestina gruppi `requiresManualReview`
   *   - Non cestina gruppi sotto `autoDeleteMinScore`
   *   - Cap sul numero totale di file per batch (`batchSizeCap`)
   */
  ipcMain.handle('duplicates:auto-delete', async (_e, payload = null) => {
    try {
      const batchCap = DUP_CFG.batchSizeCap ?? 500;
      const minScore = DUP_CFG.autoDeleteMinScore ?? 0.95;

      // Normalizza il payload in un array di { filePath, ... metadati }
      let items = [];
      if (payload && Array.isArray(payload.items)) {
        items = payload.items.filter(x => x && x.filePath);
      } else if (Array.isArray(payload) && payload.length > 0) {
        items = payload.filter(Boolean).map(p => ({ filePath: p }));
      } else {
        // Fallback dal report in state
        const groups = appState.duplicateReport || [];
        for (const g of groups) {
          if (g.requiresManualReview) continue;
          if (Number(g.similarityScore || 0) < minScore) continue;
          if (g.matchType !== 'acoustic_exact' && g.matchType !== 'acr_exact') continue;
          const keeper = g.items?.find(i => i.recommended);
          for (const it of (g.items || [])) {
            if (!it.recommended && it.filePath) {
              items.push({
                filePath: it.filePath,
                fileSize: it.fileSize || 0,
                keeperPath: keeper?.filePath || '',
                matchType: g.matchType,
                score: g.similarityScore,
              });
            }
          }
        }
      }

      if (items.length > batchCap) {
        return fail(new Error(
          `Troppi doppioni (${items.length}) per auto-delete (cap: ${batchCap}). ` +
          `Usa il tab Doppioni per revisione manuale.`
        ));
      }

      const deleted = [];
      const errors = [];
      const logEntries = [];
      const now = new Date().toISOString();

      for (const it of items) {
        const p = it.filePath;
        try {
          if (!fs.existsSync(p)) continue;
          await shell.trashItem(p);
          deleted.push(p);
          logEntries.push({
            path: p,
            fileName: path.basename(p),
            trashedAt: now,
            reason: it.keeperPath
              ? `Doppione di: ${path.basename(it.keeperPath)}`
              : 'Doppione',
            keeperPath: it.keeperPath || '',
            matchType: it.matchType || '',
            score: it.score || 0,
            fileSize: it.fileSize || 0,
          });
          const idx = appState.loadedTracks.findIndex(t => t.filePath === p);
          if (idx >= 0) appState.loadedTracks.splice(idx, 1);
        } catch (err) {
          errors.push({ path: p, error: String(err?.message || err) });
        }
      }

      if (logEntries.length > 0) appendTrashLog(logEntries);

      emitLog('success', '🗑️', `Doppioni nel cestino: ${deleted.length}${errors.length ? ` (${errors.length} errori)` : ''}`);
      return ok({ deleted: deleted.length, errors });
    } catch (e) { return fail(e); }
  });

  // Storico eliminazioni: lista degli ultimi file cestinati.
  ipcMain.handle('duplicates:get-trash-log', async () => {
    try {
      return ok(store.get('trashedFiles', []));
    } catch (e) { return fail(e); }
  });

  // "Undo last": non può ripristinare programmaticamente dal Cestino Windows,
  // ma ritorna la entry più recente così il renderer può mostrare il path
  // all'utente e aprire il Cestino.
  ipcMain.handle('duplicates:undo-last', async () => {
    try {
      const log = store.get('trashedFiles', []);
      if (log.length === 0) return ok({ success: false, message: 'Storico vuoto' });
      const last = log[log.length - 1];
      return ok({
        success: true,
        file: last,
        message:
          `Apri il Cestino di Windows e cerca: ${last.fileName}\n` +
          `Eliminato il ${last.trashedAt}`,
      });
    } catch (e) { return fail(e); }
  });

  // Pulisci lo storico (es. l'utente vuole ricominciare da capo)
  ipcMain.handle('duplicates:clear-trash-log', async () => {
    try {
      store.set('trashedFiles', []);
      return ok(true);
    } catch (e) { return fail(e); }
  });

  // ── Rename ───────────────────────────────────────────────────────
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

  // ── Low-level legacy ─────────────────────────────────────────────
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

module.exports = { register };
