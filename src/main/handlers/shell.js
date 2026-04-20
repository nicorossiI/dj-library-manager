/**
 * src/main/handlers/shell.js
 *
 * Handler: dialog:selectFolder, dialog:selectExistingLibrary, files:selectFiles,
 *          shell:open-folder, shell:open-file, shell:copy-text (+ camelCase legacy).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { dialog, shell, clipboard } = require('electron');

function register(ctx) {
  const { ipcMain, store, getMainWindow, appState, ok, fail, validateOutputPath, emitLog } = ctx;

  ipcMain.handle('dialog:selectFolder', async () => {
    try {
      const win = getMainWindow();
      const r = await dialog.showOpenDialog(win, {
        title: 'Seleziona cartella libreria musicale',
        properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return ok(null);
      const chosen = r.filePaths[0];
      const vErr = validateOutputPath(chosen);
      if (vErr) {
        emitLog('error', '❌', `Cartella rifiutata: ${vErr}`);
        return fail(new Error(vErr));
      }
      store.set('ui.lastFolder', chosen);
      appState.sourceFolder = chosen;
      return ok(chosen);
    } catch (e) { return fail(e); }
  });

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

  // camelCase legacy (usati ancora dal preload attuale)
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
}

module.exports = { register };
