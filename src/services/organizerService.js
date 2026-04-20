/**
 * src/services/organizerService.js
 *
 * Organizza la libreria in "DJ Library Organizzata" DENTRO la cartella sorgente.
 * Output Rekordbox-USB compatible.
 *
 * API pubblica (spec):
 *   calculateOutputRoot(sourceFolder)        → string  (path assoluto, dated se esiste)
 *   previewOrganization(tracks, sourceFolder)→ { outputRoot, tree, stats }
 *   executeOrganization(tracks, sourceFolder, onProgress) → { outputRoot, copied, failed, foldersCreated, ... }
 *
 * Retro-compat:
 *   organize(tracks, sourceFolder, opts)     → OrganizeResult + rekordbox.xml
 *   buildRekordboxXml(tracks)
 *
 * Modalità: SEMPRE "copy" — i file originali NON vengono toccati.
 *
 * Dipendenze: path, fs, FOLDER_STRUCTURE, fileUtils, stringUtils, OrganizeResult, CONFIG
 */

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const { CONFIG } = require('../constants/CONFIG');
const { resolveFolder } = require('../constants/FOLDER_STRUCTURE');
const { ensureDir, safeCopy } = require('../utils/fileUtils');
const { pathToRekordboxUri } = require('../utils/stringUtils');
const OrganizeResult = require('../models/OrganizeResult');

// ---------------------------------------------------------------------------
// calculateOutputRoot
// ---------------------------------------------------------------------------

/**
 * Ritorna il path assoluto della cartella output.
 * - Se `customRoot` è passato E esiste → usa quello direttamente (l'utente
 *   sceglie la sua cartella di destinazione, pronta a essere popolata).
 * - Altrimenti: `<sourceFolder>/DJ Library Organizzata` con suffisso data
 *   se esiste già, per evitare sovrascritture.
 */
async function calculateOutputRoot(sourceFolder, customRoot = null) {
  if (customRoot && String(customRoot).trim()) {
    const p = String(customRoot).trim();
    if (fs.existsSync(p)) return p;
    // se il path è stato scelto ma non esiste ancora, lo creiamo come-è
    return p;
  }
  if (!sourceFolder) throw new Error('calculateOutputRoot: sourceFolder mancante');
  const base = path.join(sourceFolder, CONFIG.OUTPUT_FOLDER_NAME);
  if (!fs.existsSync(base)) return base;

  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dated = path.join(sourceFolder, `${CONFIG.OUTPUT_FOLDER_NAME} ${d}`);
  if (!fs.existsSync(dated)) return dated;

  for (let i = 1; i < 1000; i++) {
    const cand = path.join(sourceFolder, `${CONFIG.OUTPUT_FOLDER_NAME} ${d} (${i})`);
    if (!fs.existsSync(cand)) return cand;
  }
  return dated; // fallback improbabile
}

// ---------------------------------------------------------------------------
// Tree builder helper
// ---------------------------------------------------------------------------

/**
 * Aggiunge un track al tree (struttura PIATTA).
 *   rel "Afro House" → tree["Afro House"] = [tracks]
 */
function addToTree(tree, rel, track) {
  const name = String(rel).split(/[\\/]+/).filter(Boolean)[0] || 'Da Controllare';
  if (!Array.isArray(tree[name])) tree[name] = [];
  tree[name].push(track);
}

// ---------------------------------------------------------------------------
// previewOrganization
// ---------------------------------------------------------------------------

/**
 * Calcola target per ogni track SENZA toccare il filesystem.
 * Muta ogni Track con:
 *   - targetFolder    (relative, "Afro House Vocals Spagnole/Singoli")
 *   - newFilePath     (assoluto: outputRoot + rel + newFileName)
 *   - rekordboxUri    (file://localhost/...)
 *   - rekordboxPlaylistFolder (per successivo export XML)
 */
async function previewOrganization(tracks, sourceFolder, opts = {}) {
  const outputRoot = await calculateOutputRoot(sourceFolder, opts.customRoot);
  const tree = {};
  const foldersSeen = new Set();
  const stats = {
    foldersToCreate: 0,
    filesToCopy: 0,
    unclassified: 0,
    totalSizeBytes: 0,
  };

  for (const t of tracks || []) {
    const folderName = resolveFolder(t);
    t.targetFolder = folderName;
    t.targetSubfolder = null; // struttura piatta — niente sottocartelle

    const fileName = t.newFileName || t.fileName || (t.filePath ? path.basename(t.filePath) : 'untitled.mp3');
    t.newFilePath = path.join(outputRoot, folderName, fileName);
    t.rekordboxUri = pathToRekordboxUri(t.newFilePath);

    // Playlist Rekordbox = cartella piatta (nessuna gerarchia)
    t.rekordboxPlaylistFolder = folderName;

    addToTree(tree, folderName, t);
    foldersSeen.add(folderName);

    stats.filesToCopy++;
    stats.totalSizeBytes += Number(t.fileSize) || 0;
    if (folderName === 'Da Controllare') stats.unclassified++;
  }

  stats.foldersToCreate = foldersSeen.size;
  return { outputRoot, tree, stats };
}

// ---------------------------------------------------------------------------
// executeOrganization (SEMPRE copy — non tocca originali)
// ---------------------------------------------------------------------------

/**
 * 1) Calcola outputRoot (o riusa quello del preview) e path targets
 * 2) Crea tutte le cartelle necessarie
 * 3) Copia ogni file da t.filePath → t.newFilePath (uniquePath su collisioni)
 * 4) Aggiorna t.newFilePath/t.rekordboxUri con il path finale effettivo
 * 5) t.status = 'organized'
 *
 * @param {(done,total,fileName,targetFolder)=>void} onProgress
 */
async function executeOrganization(tracks, sourceFolder, onProgress, opts = {}) {
  const list = tracks || [];
  // Preview rifatto qui per garantire path coerenti (idempotente sui Track)
  const { outputRoot } = await previewOrganization(list, sourceFolder, opts);

  // 2) Crea dirs (dedup)
  const dirsToCreate = new Set([outputRoot]);
  for (const t of list) {
    if (t.targetFolder) dirsToCreate.add(path.join(outputRoot, t.targetFolder));
  }
  for (const d of dirsToCreate) {
    await ensureDir(d);
  }

  const copied = [];
  const failed = [];
  const total = list.length;
  let done = 0;

  for (const t of list) {
    try {
      if (!t.filePath) throw new Error('filePath mancante');
      if (!t.newFilePath) throw new Error('newFilePath non calcolato');

      // 3) Copia atomica: safeCopy usa COPYFILE_EXCL che fallisce con EEXIST
      //    se il dest esiste, poi retry automatico con counter " (1)", " (2)", …
      //    Nessuna race fra check-existence e write.
      const finalPath = await safeCopy(t.filePath, t.newFilePath);

      // 4) Aggiorna Track con path finale
      t.newFilePath = finalPath;
      t.newFileName = path.basename(finalPath);
      t.rekordboxUri = pathToRekordboxUri(finalPath);
      t.status = 'organized';

      copied.push({ trackId: t.id, from: t.filePath, to: finalPath, targetFolder: t.targetFolder });
    } catch (err) {
      failed.push({ trackId: t.id, from: t.filePath, error: err.message });
    }

    done++;
    if (typeof onProgress === 'function') {
      try {
        const fn = t.newFileName || (t.newFilePath ? path.basename(t.newFilePath) : '');
        onProgress(done, total, fn, t.targetFolder || '');
      } catch { /* noop */ }
    }
  }

  return {
    outputRoot,
    copied: copied.length,
    failed: failed.length,
    foldersCreated: dirsToCreate.size,
    copiedFiles: copied,
    failures: failed,
  };
}

// ---------------------------------------------------------------------------
// Retro-compat: organize() + buildRekordboxXml (usati ancora da ipcHandlers)
// ---------------------------------------------------------------------------

/**
 * One-shot legacy: organizza + scrive rekordbox.xml.
 * Delega a executeOrganization + rekordboxExportService.generateRekordboxXml
 * (il nuovo generatore, con playlist popolate nell'ordine serata).
 *
 * Prima chiamava un `buildRekordboxXml` locale che produceva un XML con
 * `<PLAYLISTS><NODE Name="ROOT" Count="0"/></PLAYLISTS>` vuoto: le tracce
 * finivano in COLLECTION ma nessuna playlist, inutile in Rekordbox.
 */
async function organize(tracks, sourceRoot, {
  writeRekordbox = true,
  onProgress = null,
} = {}) {
  const result = new OrganizeResult();
  const res = await executeOrganization(tracks, sourceRoot, (done, total, fileName) => {
    if (typeof onProgress === 'function') {
      try { onProgress({ done, total, fileName }); } catch { /* noop */ }
    }
  });

  result.destRoot = res.outputRoot;
  for (const c of res.copiedFiles) result.addMoved(c.from, c.to, null);
  for (const f of res.failures) result.addError(f.from, new Error(f.error));

  if (writeRekordbox) {
    // Delay-require per rompere cycle potenziali (rekordboxExportService
    // non importa organizerService, ma manteniamo la regola).
    const rekordboxExportService = require('./rekordboxExportService');
    const xmlPath = await rekordboxExportService.generateRekordboxXml(tracks, res.outputRoot);
    result.rekordboxXmlPath = xmlPath;
    tracks.forEach(t => { if (t.status === 'organized') t.status = 'exported'; });
  }
  return result.finalize();
}

/**
 * Wrapper retro-compat: delega al nuovo generator.
 * Usa `organize()` con un outputRoot già calcolato se serve solo l'XML.
 * Firma preservata per i test che lo chiamavano passando un array di track.
 */
function buildRekordboxXml(tracks) {
  const rekordboxExportService = require('./rekordboxExportService');
  const idMap = new Map();
  (tracks || []).forEach((t, i) => {
    const id = i + 1;
    t.rekordboxTrackId = id;
    if (t.id) idMap.set(t.id, id);
  });
  const collection = rekordboxExportService.buildCollectionXml(tracks || [], idMap);
  const playlists = rekordboxExportService.buildPlaylistsXml(tracks || [], idMap);
  return (
`<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="DJ Library Manager" Version="1.0.0" Company="Nicho DJ Tools"/>
  <COLLECTION Entries="${(tracks || []).length}">
${collection}
  </COLLECTION>
${playlists}
</DJ_PLAYLISTS>
`);
}

module.exports = {
  // spec
  calculateOutputRoot,
  previewOrganization,
  executeOrganization,
  // retro-compat
  organize,
  buildRekordboxXml,
};
