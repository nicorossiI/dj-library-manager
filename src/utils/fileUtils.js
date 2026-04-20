/**
 * src/utils/fileUtils.js
 *
 * Operazioni filesystem: scansione ricorsiva file audio, move sicuro con
 * fallback copy+delete (cross-device), ensure dir, generazione path unico.
 *
 * Esporta: walkAudioFiles, safeMove, safeCopy, ensureDir, uniquePath
 * Dipendenze: fs, path, CONFIG
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { CONFIG } = require('../constants/CONFIG');

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function walkAudioFiles(rootDir, { maxDepth = CONFIG.MAX_SCAN_DEPTH } = {}) {
  const results = [];
  const exts = new Set(CONFIG.AUDIO_EXTENSIONS.map(e => e.toLowerCase()));

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (CONFIG.SKIP_HIDDEN_FILES && e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Evita di ricorrere dentro la cartella output già generata
        if (e.name === CONFIG.OUTPUT_FOLDER_NAME) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (exts.has(ext)) results.push(full);
      }
    }
  }

  await walk(rootDir, 0);
  return results;
}

/**
 * Ritorna un path che NON esiste al momento della chiamata.
 * ATTENZIONE: tra la risoluzione e la scrittura c'è una finestra di race.
 * Usa safeCopy/safeMove (che sfruttano COPYFILE_EXCL) per operazioni atomiche.
 * Questo helper resta utile per la preview (newFilePath non ancora scritto).
 */
async function uniquePath(targetPath) {
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let candidate = targetPath;
  let i = 1;
  while (true) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, `${base} (${i})${ext}`);
      i++;
    } catch {
      return candidate;
    }
  }
}

/**
 * Genera candidato N basato su `targetPath`. N=0 → targetPath stesso.
 * N=1 → "Name (1).ext", N=2 → "Name (2).ext", ecc.
 */
function _candidate(targetPath, i) {
  if (i === 0) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  return path.join(dir, `${base} (${i})${ext}`);
}

/**
 * Copia atomica: usa COPYFILE_EXCL che fallisce con EEXIST se il dest esiste.
 * Se non `overwrite`, loop sul counter finché trova un nome libero e la copia
 * va a buon fine atomicamente. Previene la race di uniquePath+copyFile separati.
 */
async function safeCopy(from, to, { overwrite = false } = {}) {
  await ensureDir(path.dirname(to));
  if (overwrite) {
    await fsp.copyFile(from, to);
    return to;
  }
  const MAX = 1000;
  for (let i = 0; i < MAX; i++) {
    const candidate = _candidate(to, i);
    try {
      await fsp.copyFile(from, candidate, fs.constants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // dest esiste: prova il prossimo counter
    }
  }
  throw new Error(`safeCopy: impossibile trovare nome libero dopo ${MAX} tentativi per ${to}`);
}

/**
 * Move atomico: prova rename (preserva inode, EEXIST/EPERM su Windows se dest esiste),
 * poi falliamo esplicitamente prima di sovrascrivere. Fallback copy+unlink su EXDEV.
 */
async function safeMove(from, to, { overwrite = false, copyThenDelete = false } = {}) {
  await ensureDir(path.dirname(to));

  if (copyThenDelete) {
    const finalPath = await safeCopy(from, to, { overwrite });
    await fsp.unlink(from).catch(() => {});
    return finalPath;
  }

  const MAX = 1000;
  for (let i = 0; i < (overwrite ? 1 : MAX); i++) {
    const candidate = overwrite ? to : _candidate(to, i);
    try {
      // Su Windows rename fallisce con EEXIST/EPERM se il dest esiste.
      // Su POSIX rename è atomic-replace: controlliamo noi prima.
      if (!overwrite) {
        try {
          await fsp.access(candidate);
          continue; // esiste, prossimo candidato
        } catch { /* non esiste: procedi */ }
      }
      await fsp.rename(from, candidate);
      return candidate;
    } catch (err) {
      if (err.code === 'EXDEV') {
        // Cross-device: fallback atomico via safeCopy + unlink.
        const finalPath = await safeCopy(from, overwrite ? to : _candidate(to, i), { overwrite });
        await fsp.unlink(from).catch(() => {});
        return finalPath;
      }
      if (err.code === 'EEXIST' || err.code === 'EPERM') continue;
      throw err;
    }
  }
  throw new Error(`safeMove: impossibile trovare nome libero dopo ${MAX} tentativi per ${to}`);
}

async function fileStat(p) {
  try { return await fsp.stat(p); } catch { return null; }
}

module.exports = {
  walkAudioFiles,
  safeMove,
  safeCopy,
  ensureDir,
  uniquePath,
  fileStat,
};
