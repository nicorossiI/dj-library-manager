/**
 * wizard-preload.js
 * Bridge dedicato al wizard di primo avvio. Espone solo gli IPC necessari.
 */
'use strict';

const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('wizardApi', {
  pickFolder:   () => ipcRenderer.invoke('dialog:selectFolder'),
  testApi:      (cfg) => ipcRenderer.invoke('wizard:test-api', cfg),
  complete:     (payload) => ipcRenderer.send('wizard:complete', payload),
  skip:         () => ipcRenderer.send('wizard:skip'),
  openExternal: (url) => shell.openExternal(url),
});
