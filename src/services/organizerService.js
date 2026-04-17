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
const {
  FOLDER_NAMES,
  FLAT_FOLDERS,
  SUBFOLDERS,
  resolveTargetFolder,
} = require('../constants/FOLDER_STRUCTURE');
const { ensureDir, uniquePath } = require('../utils/fileUtils');
const { pathToRekordboxUri } = require('../utils/stringUtils');
const OrganizeResult = require('../models/OrganizeResult');

// ---------------------------------------------------------------------------
// calculateOutputRoot
// ---------------------------------------------------------------------------

/**
 * Ritorna il path assoluto della cartella output:
 *   <sourceFolder>/DJ Library Organizzata
 * Se esiste già: appende la data ISO (YYYY-MM-DD). Se anche la versione dated
 * esiste, incrementa un contatore. Evita sovrascritture accidentali.
 */
async function calculateOutputRoot(sourceFolder) {
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
 * Aggiunge un track al tree gerarchico.
 *   rel "A/B"       → tree[A][B] = [tracks]
 *   rel "A" (flat)  → tree[A]    = [tracks]
 */
function addToTree(tree, rel, track) {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean);
  if (parts.length === 1) {
    if (!Array.isArray(tree[parts[0]])) tree[parts[0]] = [];
    tree[parts[0]].push(track);
  } else if (parts.length >= 2) {
    const [p0, p1] = parts;
    if (!tree[p0] || Array.isArray(tree[p0])) tree[p0] = {};
    if (!Array.isArray(tree[p0][p1])) tree[p0][p1] = [];
    tree[p0][p1].push(track);
  }
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
async function previewOrganization(tracks, sourceFolder) {
  const outputRoot = await calculateOutputRoot(sourceFolder);
  const tree = {};
  const foldersSeen = new Set();
  const stats = {
    foldersToCreate: 0,
    filesToCopy: 0,
    unclassified: 0,
    totalSizeBytes: 0,
  };

  for (const t of tracks || []) {
    const rel = resolveTargetFolder(t);
    t.targetFolder = rel;

    const fileName = t.newFileName || t.fileName || (t.filePath ? path.basename(t.filePath) : 'untitled.mp3');
    t.newFilePath = path.join(outputRoot, rel, fileName);
    t.rekordboxUri = pathToRekordboxUri(t.newFilePath);

    // Popola i campi playlist per il futuro export rekordbox.xml
    const relParts = rel.split(/[\\/]+/).filter(Boolean);
    t.rekordboxPlaylistFolder = relParts[0] || '';
    t.rekordboxPlaylistName = relParts[1] || '';

    addToTree(tree, rel, t);
    foldersSeen.add(rel);

    stats.filesToCopy++;
    stats.totalSizeBytes += Number(t.fileSize) || 0;
    if (rel === FOLDER_NAMES.UNCLASSIFIED) stats.unclassified++;
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
async function executeOrganization(tracks, sourceFolder, onProgress) {
  const list = tracks || [];
  // Preview rifatto qui per garantire path coerenti (idempotente sui Track)
  const { outputRoot } = await previewOrganization(list, sourceFolder);

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
