/**
 * src/main/ipcHandlers.js
 *
 * Shim di retrocompatibilità — il codice è stato splittato in
 * src/main/handlers/ per dominio (analysis, organize, rekordbox, library,
 * settings, shell, updater, watcher). Questo file ri-esporta il registrar
 * per non rompere `require('./ipcHandlers')` in main.js e codice esterno.
 *
 * Esporta: registerIpcHandlers({ store, getMainWindow }), getAppState()
 */

'use strict';

module.exports = require('./handlers');
