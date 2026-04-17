/**
 * src/main/updaterService.js
 *
 * Auto-updater via electron-updater su GitHub Releases.
 * Scarica in background e installa alla chiusura — l'utente non fa nulla.
 * Inattivo quando !app.isPackaged (dev mode).
 *
 * Esporta: init(mainWindow), checkForUpdates(), installNow()
 * Canali push: update:available, update:progress, update:ready
 */

'use strict';

const { app } = require('electron');

let _mainWindow = null;
let _initialized = false;
let autoUpdater = null;

function send(channel, data) {
  if (_mainWindow && !_mainWindow.isDestroyed()) {
    try { _mainWindow.webContents.send(channel, data); } catch { /* noop */ }
  }
}

function init(mainWindow) {
  _mainWindow = mainWindow;

  if (!app.isPackaged) {
    console.log('[Updater] Sviluppo: auto-update disabilitato');
    return;
  }
  if (_initialized) return;
  _initialized = true;

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.warn('[Updater] electron-updater non disponibile:', e.message);
    return;
  }

  try {
    const log = require('electron-log');
    autoUpdater.logger = log;
    log.transports.file.level = 'info';
  } catch { /* logger opzionale */ }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Controllo aggiornamenti...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] Aggiornamento disponibile:', info?.version);
    send('update:available', {
      version: info?.version,
      releaseNotes: info?.releaseNotes,
      message: `Nuova versione ${info?.version} disponibile. Download in corso...`,
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] App aggiornata');
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress?.percent || 0);
    send('update:progress', { percent: pct, message: `Download aggiornamento: ${pct}%` });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Aggiornamento scaricato:', info?.version);
    send('update:ready', {
      version: info?.version,
      message: `Versione ${info?.version} pronta. Verrà installata alla prossima chiusura.`,
    });
  });

  autoUpdater.on('error', (err) => {
    console.warn('[Updater] Errore:', err?.message || err);
  });

  checkForUpdates();
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
}

function checkForUpdates() {
  if (!app.isPackaged || !autoUpdater) return;
  autoUpdater.checkForUpdates().catch(e => {
    console.warn('[Updater] Check fallito:', e?.message || e);
  });
}

function installNow() {
  if (!autoUpdater) return;
  try { autoUpdater.quitAndInstall(false, true); }
  catch (e) { console.warn('[Updater] quitAndInstall error:', e?.message); }
}

module.exports = { init, checkForUpdates, installNow };
