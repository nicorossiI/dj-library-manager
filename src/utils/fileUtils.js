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

async function safeCopy(from, to, { overwrite = false } = {}) {
  await ensureDir(path.dirname(to));
  const finalPath = overwrite ? to : await uniquePath(to);
  await fsp.copyFile(from, finalPath);
  return finalPath;
}

async function safeMove(from, to, { overwrite = false, copyThenDelete = false } = {}) {
  await ensureDir(path.dirname(to));
  const finalPath = overwrite ? to : await uniquePath(to);
  if (copyThenDelete) {
    await fsp.copyFile(from, finalPath);
    await fsp.unlink(from).catch(() => {});
    return finalPath;
  }
  try {
    await fsp.rename(from, finalPath);
    return finalPath;
  } catch (err) {
    if (err.code === 'EXDEV') {
      // cross-device: fallback copy+delete
      await fsp.copyFile(from, finalPath);
      await fsp.unlink(from).catch(() => {});
      return finalPath;
    }
    throw err;
  }
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
