/**
 * src/renderer/preload.js
 *
 * Bridge sicuro main↔renderer. contextBridge + contextIsolation.
 * Espone window.api con metodi semantici per i 6 tab + i nuovi canali
 * pipeline (analysis:start, organize:execute, rekordbox:generate-xml).
 *
 * Esporta (side-effect): window.api
 */

'use strict';

const { contextBridge, ipcRenderer, webUtils, shell } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

// Wrapper deprecazione: chiama il canale nuovo stampando warning in console.
// Da rimuovere in v1.5.x quando tutti i chiamanti nel renderer sono migrati.
const _deprecatedOnce = new Set();
function deprecated(oldCh, newCh, invokeFn) {
  return (...args) => {
    if (!_deprecatedOnce.has(oldCh)) {
      console.warn(`[DEPRECATED] ${oldCh} → usa ${newCh}`);
      _deprecatedOnce.add(oldCh);
    }
    return invokeFn(...args);
  };
}

function listener(channel) {
  return (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  };
}

const api = {
  // ── Tab CARICA ────────────────────────────────────────────────────
  selectFolder:  ()        => invoke('dialog:selectFolder'),
  selectFiles:   ()        => invoke('files:selectFiles'),
  scanFolder:    (folder)  => invoke('library:scan', folder),
  scanFiles:     (paths)   => invoke('library:scanFiles', paths),

  // ── Modalità "aggiungi a libreria esistente" ─────────────────────
  selectExistingLibrary: () => invoke('dialog:selectExistingLibrary'),
  updateExisting: (payload) => invoke('library:update-existing', payload),

  // ── Folder watcher (chokidar) ────────────────────────────────────
  watcherStart:  (payload) => invoke('watcher:start', payload || {}),
  watcherStop:   () => invoke('watcher:stop'),
  watcherStatus: () => invoke('watcher:status'),

  // ── Tab ANALISI ───────────────────────────────────────────────────
  // Pipeline orchestrata 4 fasi (legge sourceFolder dallo stato del main).
  analysisStart: (sourceFolder) => invoke('analysis:start', sourceFolder),
  // Legacy: invia tracks già caricati (deprecato, usa analysisStart)
  analyzeFull:   deprecated('library:analyzeFull', 'analysis:start',
                  (tracks) => invoke('library:analyzeFull', tracks)),

  // ── Tab DOPPIONI ──────────────────────────────────────────────────
  findDuplicates: (tracks) => invoke('library:findDuplicates', tracks),
  findCrossMixDuplicates: (tracks) => invoke('duplicates:cross-mix', tracks),
  autoDeleteDuplicates: (payload) => invoke('duplicates:auto-delete', payload || null),
  getTrashLog:        () => invoke('duplicates:get-trash-log'),
  undoLastTrash:      () => invoke('duplicates:undo-last'),
  clearTrashLog:      () => invoke('duplicates:clear-trash-log'),

  // ── Tab RINOMINA ──────────────────────────────────────────────────
  previewRename:  (tracks) => invoke('library:rename', { tracks }),
  executeRename:  (payload)=> invoke('library:executeRename', payload),

  // ── Tab ORGANIZZA ─────────────────────────────────────────────────
  // Spec channels (kebab-case)
  organizePreview: (payload) => invoke('organize:preview', payload),
  organizeExecute: (payload) => invoke('organize:execute', payload),
  // Legacy alias deprecati
  previewOrganization: deprecated('previewOrganization', 'organizePreview',
                        (payload) => invoke('organize:preview', payload)),
  executeOrganization: deprecated('executeOrganization', 'organizeExecute',
                        (payload) => invoke('organize:execute', payload)),

  // ── Tab REKORDBOX ─────────────────────────────────────────────────
  rekordboxPreview:  () => invoke('rekordbox:preview'),
  rekordboxGenerate: () => invoke('rekordbox:generate-xml'),
  // Legacy deprecato (accetta payload con tracks/outputRoot)
  exportRekordbox:   deprecated('library:exportRekordbox', 'rekordbox:generate-xml',
                       (payload) => invoke('library:exportRekordbox', payload)),

  // ── Settings + API ────────────────────────────────────────────────
  getSettings:  () => invoke('settings:get'),
  setSettings:  (s) => invoke('settings:set', s),
  configGet:    (key) => invoke('config:get', key),
  configSet:    (key, value) => invoke('config:set', key, value),
  testApi:      deprecated('config:testApi', 'config:test-api',
                  () => invoke('config:testApi')),  // legacy: ritorna {online,reason,responseTime}
  testApiFull:  () => invoke('config:test-api'),    // spec: ritorna {success,responseTime,error}
  testShazam:   () => invoke('shazam:test'),        // { ok, message }
  testReplicate: (token) => invoke('replicate:test', token || null),
  testAcoustid: (key) => invoke('acoustid:test', key || ''),

  // ── Drop zone helper (Electron v32+: File.path rimosso, serve webUtils)
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); }
    catch { return file?.path || ''; }
  },

  // ── Shell ─────────────────────────────────────────────────────────
  openFolder: (path) => invoke('shell:open-folder', path),
  openFile:   (path) => invoke('shell:open-file', path),
  copyText:   (text) => invoke('shell:copy-text', text),
  getDiskInfo:(path) => invoke('disk:info', path),
  openExternal: (url) => { try { shell.openExternal(url); } catch { /* noop */ } },

  // ── Eventi push da main ───────────────────────────────────────────
  onProgress:           listener('library:progress'),
  onLog:                listener('library:log'),
  onAnalysisProgress:   listener('analysis:progress'),
  onAnalysisComplete:   listener('analysis:complete'),
  onCrossMixDuplicates: listener('analysis:cross-mix-duplicates'),
  onOrganizeProgress:   listener('organize:progress'),
  onOrganizeComplete:   listener('organize:complete'),
  onRekordboxProgress:  listener('rekordbox:progress'),
  onRekordboxComplete:  listener('rekordbox:xml-complete'),
  onUpdateProgress:     listener('library:update-progress'),
  onWatcherProcessed:   listener('watcher:file-processed'),
  onWatcherError:       listener('watcher:file-error'),

  // ── Auto-updater ─────────────────────────────────────────────────
  updateInstallNow:  () => invoke('update:install-now'),
  updateCheck:       () => invoke('update:check'),
  onUpdateAvailable: listener('update:available'),
  onUpdateDownload:  listener('update:progress'),
  onUpdateReady:     listener('update:ready'),
};

contextBridge.exposeInMainWorld('api', api);
