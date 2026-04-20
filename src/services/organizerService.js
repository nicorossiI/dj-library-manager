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
const { ensureDir, uniquePath } = require('../utils/fileUtils');
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
 *   - rekordboxPlaylistFolder + rekordboxPlaylistName (per successivo export XML)
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
    t.rekordboxPlaylistName = '';

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

      // 3) Collisione → (2), (3), ...
      const finalPath = await uniquePath(t.newFilePath);
      await fsp.copyFile(t.filePath, finalPath);

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
    const xmlPath = path.join(res.outputRoot, CONFIG.REKORDBOX_XML_NAME);
    const xml = buildRekordboxXml(tracks);
    await fsp.writeFile(xmlPath, xml, 'utf8');
    result.rekordboxXmlPath = xmlPath;
    tracks.forEach(t => { if (t.status === 'organized') t.status = 'exported'; });
  }
  return result.finalize();
}

function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function trackXmlNode(t, trackId) {
  const uri = t.rekordboxUri || pathToRekordboxUri(t.newFilePath || t.filePath);
  const bpmFormatted = t.bpm ? Number(t.bpm).toFixed(2) : '0.00';
  const bestTitle = t.recognizedTitle || t.localTitle || (t.fileName || '').replace(/\.[^.]+$/, '');
  const bestArtist = t.recognizedArtist || t.localArtist || 'Unknown';
  return `<TRACK TrackID="${trackId}" Name="${esc(bestTitle)}" `
    + `Artist="${esc(bestArtist)}" `
    + `Album="${esc(t.recognizedAlbum || '')}" `
    + `Genre="${esc(t.detectedGenre || '')}" `
    + `AverageBpm="${bpmFormatted}" `
    + `TotalTime="${Math.round(t.duration || 0)}" `
    + `Kind="${esc(String(t.format || '').toUpperCase())} File" `
    + `Location="${uri}" />`;
}

function buildRekordboxXml(tracks) {
  const nodes = (tracks || []).map((t, i) => {
    const id = i + 1;
    t.rekordboxTrackId = id;
    return '    ' + trackXmlNode(t, id);
  }).join('\n');

  return (
`<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="DJ Library Manager" Version="0.1.0" Company="DJ Library Manager"/>
  <COLLECTION Entries="${(tracks || []).length}">
${nodes}
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="0"/>
  </PLAYLISTS>
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
