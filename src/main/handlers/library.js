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

function register(ctx) {
  const { ipcMain, appState, send, emitLog, ok, fail } = ctx;

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
