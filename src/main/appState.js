/**
 * src/main/appState.js
 *
 * Stato condiviso tra tutti gli handler IPC.
 * Singleton per il main process; i moduli che lo importano vedono lo stesso oggetto.
 */

'use strict';

const appState = {
  sourceFolder: null,
  loadedTracks: [],
  organizedTracks: [],
  outputRoot: null,
  analysisRunning: false,
  duplicateReport: null,
  crossMixDuplicates: [],
  renamePreview: [],
  organizePreview: null,
  rekordboxXmlPath: null,
};

function getAppState() { return appState; }

module.exports = { appState, getAppState };
