/**
 * src/main/handlers/organize.js
 *
 * Handler: organize:preview, organize:execute, library:previewOrganization
 * (legacy), library:executeOrganization (legacy), library:organize (legacy one-shot).
 */

'use strict';

const organizerService = require('../../services/organizerService');

function register(ctx) {
  const {
    ipcMain, store, appState,
    send, emitLog,
    ok, fail, validateOutputPath,
  } = ctx;

  function getCustomOrganizeRoot() {
    try {
      const v = store.get('organizeOutputRoot', '');
      const trimmed = (v && String(v).trim()) ? String(v).trim() : null;
      if (!trimmed) return null;
      // mustExist=false: il path può essere nuovo (verrà creato), ma non può
      // essere root del disco o cartella di sistema.
      const vErr = validateOutputPath(trimmed, { mustExist: false });
      if (vErr) {
        emitLog('error', '❌', `organizeOutputRoot rifiutato: ${vErr}`);
        throw new Error(`Cartella output non valida: ${vErr}`);
      }
      return trimmed;
    } catch (err) {
      if (err?.message?.startsWith('Cartella output non valida')) throw err;
      return null;
    }
  }

  async function doOrganizePreview({ tracks, sourceFolder } = {}) {
    const list = tracks || appState.loadedTracks;
    const folder = sourceFolder || appState.sourceFolder;
    const vErr = validateOutputPath(folder);
    if (vErr) throw new Error(vErr);
    const customRoot = getCustomOrganizeRoot();
    const r = await organizerService.previewOrganization(list, folder, { customRoot });
    appState.organizePreview = r;
    appState.outputRoot = r.outputRoot;
    return r;
  }

  async function doOrganizeExecute({ tracks, sourceFolder } = {}) {
    const list = tracks || appState.loadedTracks;
    const folder = sourceFolder || appState.sourceFolder;
    const vErr = validateOutputPath(folder);
    if (vErr) throw new Error(vErr);
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
    appState.organizedTracks = list;
    appState.outputRoot = r.outputRoot;

    if (r.copied === 0 && list.length > 0) {
      const msg = `Nessun file copiato su ${r.outputRoot}. Verifica permessi di scrittura.`;
      emitLog('error', '❌', msg);
      send('organize:error', { message: msg, outputRoot: r.outputRoot });
    } else if (r.failed > 0) {
      emitLog('warn', '⚠️', `Copia parziale: ${r.copied} ok, ${r.failed} errori`);
    }

    send('organize:complete', { outputRoot: r.outputRoot, stats: {
      copied: r.copied, failed: r.failed, foldersCreated: r.foldersCreated,
    }});
    return r;
  }

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
      const res = await organizerService.organize(
        tracks || appState.loadedTracks,
        sourceRoot || appState.sourceFolder,
        {
          mode, writeRekordbox: true,
          onProgress: (p) => send('library:progress', p),
        },
      );
      return ok(res.toJSON());
    } catch (e) { return fail(e); }
  });
}

module.exports = { register };
