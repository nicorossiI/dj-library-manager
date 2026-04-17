/**
 * src/main/windowManager.js
 *
 * Crea la BrowserWindow principale con preload e contextIsolation attivi.
 * In modalità dev apre automaticamente DevTools.
 *
 * Esporta: createMainWindow
 * Dipendenze: electron, path
 */

'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');

function createMainWindow({ dev = false } = {}) {
  const win = new BrowserWindow({
    width: 1300,
    height: 860,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0d0d0d',
    title: 'DJ Library Manager',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload ha bisogno di require('electron')
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (dev) win.webContents.openDevTools({ mode: 'detach' });

  return win;
}

module.exports = { createMainWindow };
