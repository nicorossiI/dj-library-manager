/**
 * src/main/main.js
 *
 * Entry point Electron. Single-instance lock, bootstrap store, dotenv in dev,
 * creazione finestra principale e registrazione IPC handlers.
 *
 * IMPORTANTE: electron-store viene istanziato SENZA opzioni custom di path.
 * Di default usa app.getPath('userData') → %APPDATA%/dj-library-manager.
 * NESSUNA logica "portable" env var. L'app funziona identica da USB, Desktop,
 * Documenti, ecc. perché la config sta sempre in AppData dell'utente.
 *
 * Esporta: (nessuno - main Electron)
 * Dipendenze: electron, electron-store, dotenv (opzionale), ipcHandlers, windowManager
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain } = require('electron');

// Fix GPU crash "GPU process isn't usable" su alcune configurazioni Windows
// (launch da terminale, driver vecchi, VM, RDP). Electron ricade su software
// rendering senza perdita funzionale visibile all'utente DJ.
try { app.disableHardwareAcceleration(); } catch { /* noop */ }
// Flag aggiuntivi per ambiente headless / terminale
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-gpu-sandbox');

// Single-instance lock: impedisce più processi
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Dotenv: solo durante sviluppo locale (npm start / npm run dev).
// In produzione (exe distribuito) le credenziali vengono SOLO da electron-store
// (popolato dalle Impostazioni UI). Doppia guardia: NODE_ENV o app non packaged.
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
if (isDev) {
  try {
    require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
  } catch { /* dotenv opzionale */ }
}

// electron-store
// Import compatibile con CJS/ESM (electron-store v8 è CJS; v9+ è ESM)
let Store;
try {
  Store = require('electron-store');
  if (Store.default) Store = Store.default;
} catch (err) {
  console.error('electron-store import fallito:', err);
}

const { createMainWindow } = require('./windowManager');
const { registerIpcHandlers } = require('./ipcHandlers');

let store;
let mainWindow;
let wizardWindow = null;
let tray = null;

function initStore() {
  // Forza esplicitamente il cwd su app.getPath('userData') — senza questo,
  // electron-store v8 a volte cade sul fallback env-paths (Config/config.json)
  // invece di scrivere in %APPDATA%/dj-library-manager/
  store = new Store({
    name: 'dj-library-manager-config',
    cwd: app.getPath('userData'),
    defaults: {
      acrcloud: {
        host: '',
        accessKey: '',
        accessSecret: '',
      },
      ui: {
        theme: 'dark',
        lastFolder: '',
      },
      rename: {
        enabled: true,
      },
    },
  });
  return store;
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ─────────────────────────────────────────────────────────────────────
// System tray — icona in basso a destra, minimizza invece di chiudere
// ─────────────────────────────────────────────────────────────────────

function getTrayIconPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.ico'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* noop */ }
  }
  return null;
}

function createTray() {
  const iconPath = getTrayIconPath();
  if (!iconPath) return null;
  try { tray = new Tray(iconPath); } catch { tray = null; return null; }

  const rebuildMenu = () => {
    let watcherActive = false;
    try { watcherActive = require('../services/watcherService').isActive(); } catch { /* noop */ }
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: '🎧 Apri DJ Library Manager',
        click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } },
      },
      { type: 'separator' },
      {
        label: watcherActive
          ? '🟢 Watcher attivo — in ascolto nuovi file'
          : '🔴 Watcher non attivo',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: '❌ Chiudi completamente',
        click: () => { app.isQuiting = true; app.quit(); },
      },
    ]));
  };

  rebuildMenu();
  tray.setToolTip('DJ Library Manager');
  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  // Ribuild ogni 10s per aggiornare lo stato watcher (semplice polling)
  setInterval(rebuildMenu, 10_000);
  return tray;
}

function attachCloseToTray(win) {
  if (!win) return;
  win.on('close', (e) => {
    if (app.isQuiting) return;
    e.preventDefault();
    win.hide();
    try {
      if (!store.get('trayBalloonShown')) {
        if (tray && typeof tray.displayBalloon === 'function') {
          tray.displayBalloon({
            iconType: 'info',
            title: 'DJ Library Manager',
            content: "L'app è ancora attiva nel vassoio di sistema.\n" +
                     "Doppio click sull'icona per riaprirla.",
          });
        }
        store.set('trayBalloonShown', true);
      }
    } catch { /* noop */ }
  });
}

// Espone showWindowsNotification globalmente così ipcHandlers può usarlo
global.showWindowsNotification = function showWindowsNotification(type, payload = {}) {
  try {
    if (!store?.get('notificationsEnabled', true)) return;
    const titles = {
      added: { title: '🎵 Canzone aggiunta alla libreria', body: payload.body || '' },
      duplicate: { title: '⚠️ Canzone già presente', body: payload.body || '' },
      error: { title: '❌ Impossibile processare il file', body: payload.body || '' },
    };
    const m = titles[type] || titles.added;
    if (!m.body) return;
    const n = new Notification({
      title: m.title,
      body: m.body,
      icon: getTrayIconPath() || undefined,
      silent: false,
    });
    n.show();
  } catch { /* noop */ }
};

function createMainFlow() {
  mainWindow = createMainWindow({ dev: !app.isPackaged });
  createTray();
  attachCloseToTray(mainWindow);

  // Auto-start del watcher se configurato dall'utente
  try {
    const enabled = store.get('watcherEnabled', false);
    const folder = store.get('watchFolder', '');
    if (enabled && folder && fs.existsSync(folder)) {
      const watcherService = require('../services/watcherService');
      const acrcloudService = require('../services/acrcloudService');
      const metadataService = require('../services/metadataService');
      const fingerprintService = require('../services/fingerprintService');
      const bpmService = require('../services/bpmService');
      const keyService = require('../services/keyService');
      const genreClassifier = require('../services/genreClassifierService');
      const analysisCache = require('../services/analysisCache');
      analysisCache.initCache(folder);
      watcherService.start(folder, async (filePath) => {
        try {
          const track = await metadataService.readTrack(filePath);
          try { await fingerprintService.fingerprintTrack(track); } catch { /* skip */ }
          try { await bpmService.detectBpmIfMissing(track); } catch { /* skip */ }
          try { await keyService.detectKeyIfMissing(track); } catch { /* skip */ }
          try { await acrcloudService.recognizeSingleTrack(track); } catch { /* skip */ }
          try {
            const cls = await genreClassifier.classify(track);
            track.detectedGenre = cls.genre;
            track.vocalsLanguage = cls.language;
          } catch { /* skip */ }
          try { analysisCache.saveCache(); } catch { /* skip */ }
          if (global.showWindowsNotification) {
            const title = track.recognizedTitle || track.localTitle || path.basename(filePath);
            const artist = track.recognizedArtist || track.localArtist || '';
            global.showWindowsNotification('added', {
              body: artist ? `${artist} — ${title}` : title,
            });
          }
        } catch { /* skip */ }
      });
    }
  } catch (err) {
    console.error('[watcher auto-start] errore:', err);
  }
}

function createWizardWindow() {
  wizardWindow = new BrowserWindow({
    width: 640,
    height: 560,
    resizable: false,
    frame: false,
    center: true,
    backgroundColor: '#080810',
    title: 'DJ Library Manager — Setup',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'wizard-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  wizardWindow.setMenuBarVisibility(false);
  wizardWindow.loadFile(path.join(__dirname, '..', 'renderer', 'wizard.html'));
  wizardWindow.on('closed', () => { wizardWindow = null; });
}

function registerWizardHandlers() {
  ipcMain.handle('wizard:test-api', async (_e, creds = {}) => {
    try {
      const acrcloudService = require('../services/acrcloudService');
      const prev = { host: '', accessKey: '', accessSecret: '' };
      // Backup creds attuali, applica quelle del wizard temporaneamente
      try {
        const cur = store.get('acrcloud') || {};
        prev.host = cur.host || '';
        prev.accessKey = cur.accessKey || '';
        prev.accessSecret = cur.accessSecret || '';
      } catch { /* noop */ }
      acrcloudService.setCredentials(creds);
      const r = await acrcloudService.testConnection({ seconds: 5 });
      // Ripristina credenziali precedenti (il wizard salverà a completion)
      acrcloudService.setCredentials(prev);
      return { ok: true, data: { online: r.success, reason: r.error, responseTime: r.responseTime } };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.on('wizard:complete', (_e, payload = {}) => {
    try {
      store.set('setupComplete', true);
      if (payload.watchFolder) {
        store.set('watchFolder', payload.watchFolder);
        store.set('watcherEnabled', true);
      }
      if (payload.acrcloud) {
        store.set('acrcloud', payload.acrcloud);
        try {
          const acrcloudService = require('../services/acrcloudService');
          acrcloudService.setCredentials(payload.acrcloud);
        } catch { /* noop */ }
      }
      store.set('notificationsEnabled', !!payload.notificationsEnabled);
      if (process.platform === 'win32') {
        app.setLoginItemSettings({
          openAtLogin: !!payload.startWithWindows,
          openAsHidden: true,
        });
      }
    } catch (err) {
      console.error('[wizard:complete] errore:', err);
    }
    if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.close();
    createMainFlow();
  });

  ipcMain.on('wizard:skip', () => {
    try { store.set('setupComplete', true); } catch { /* noop */ }
    if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.close();
    createMainFlow();
  });
}

app.whenReady().then(() => {
  initStore();
  registerIpcHandlers({ store, getMainWindow: () => mainWindow });
  registerWizardHandlers();

  const needsWizard = !store.get('setupComplete', false);
  if (needsWizard) {
    createWizardWindow();
  } else {
    createMainFlow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (!store.get('setupComplete', false)) createWizardWindow();
      else createMainFlow();
    }
  });
});

app.on('window-all-closed', () => {
  // Con tray attivo NON chiudiamo. Solo su macOS comportamento standard.
  if (process.platform === 'darwin') app.quit();
  else if (app.isQuiting) app.quit();
});

app.on('before-quit', () => {
  // hook per cleanup futuro (code/queue flush, ecc.)
});
