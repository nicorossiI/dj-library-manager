/**
 * src/main/handlers/index.js
 *
 * Registrar centrale — chiama register(ctx) su ogni modulo handler.
 * Lo stato condiviso (appState) e i helper (send, emitLog, ecc.) sono
 * costruiti qui e passati come `ctx` a ciascun modulo.
 */

'use strict';

const { ipcMain, app } = require('electron');

const { appState, getAppState } = require('../appState');
const {
  ok, fail, pct,
  validateOutputPath,
  makeSendEvent, makeEmitLog, makeEmitAnalysisProgress,
} = require('./shared');

const settings = require('./settings');
const shell    = require('./shell');
const watcher  = require('./watcher');
const analysis = require('./analysis');
const library  = require('./library');
const organize = require('./organize');
const rekordbox = require('./rekordbox');
const updater  = require('./updater');

function registerIpcHandlers({ store, getMainWindow }) {
  const send = makeSendEvent(getMainWindow);
  const emitLog = makeEmitLog(send);
  const emitAnalysisProgress = makeEmitAnalysisProgress(send);

  const ctx = {
    ipcMain,
    app,
    store,
    getMainWindow,
    appState,
    send,
    emitLog,
    emitAnalysisProgress,
    ok,
    fail,
    pct,
    validateOutputPath,
  };

  // Boot-time: propaga credenziali salvate ai servizi
  settings.boot({ store });

  // Registra tutti gli handler IPC
  settings.register(ctx);
  shell.register(ctx);
  watcher.register(ctx);
  analysis.register(ctx);
  library.register(ctx);
  organize.register(ctx);
  rekordbox.register(ctx);
  updater.register(ctx);
}

module.exports = { registerIpcHandlers, getAppState };
