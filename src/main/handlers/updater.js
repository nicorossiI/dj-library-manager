/**
 * src/main/handlers/updater.js
 *
 * Handler: update:install-now, update:check.
 */

'use strict';

function register(ctx) {
  const { ipcMain, ok, fail } = ctx;

  ipcMain.handle('update:install-now', () => {
    try { require('../updaterService').installNow(); return ok(true); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('update:check', () => {
    try { require('../updaterService').checkForUpdates(); return ok(true); }
    catch (e) { return fail(e); }
  });
}

module.exports = { register };
