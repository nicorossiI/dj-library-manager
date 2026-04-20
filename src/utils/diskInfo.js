/**
 * src/utils/diskInfo.js
 *
 * Informazioni sul drive che ospita un path:
 *   - spazio libero/totale (via fs.statfs — cross-platform, Node ≥18.15)
 *   - se il drive è rimovibile (USB/pennetta) — Windows via PowerShell,
 *     fallback euristico (drive diverso da %SystemDrive%) altrove
 *
 * Esporta: getDiskInfo(p) → { freeBytes, totalBytes, isRemovable, driveLetter, driveType }
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { runProc } = require('./runProc');

/** Risolve la lettera di drive Windows (o null su altri OS). */
function getDriveLetter(p) {
  if (process.platform !== 'win32') return null;
  const m = String(path.resolve(p)).match(/^([A-Za-z]):/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Ottiene spazio libero/totale via fs.statfs (Node ≥ 18.15).
 * Ritorna null su errore (path non esistente, fs non supportato).
 */
async function getSpaceInfo(p) {
  if (typeof fsp.statfs !== 'function') return null;
  try {
    // statfs accetta un qualsiasi path sul filesystem; se `p` non esiste
    // proviamo con la sua parent fino alla root del drive.
    let target = path.resolve(p);
    // Scorri su finché non trovi una dir esistente (max 10 livelli)
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(target)) break;
      const parent = path.dirname(target);
      if (parent === target) break;
      target = parent;
    }
    const st = await fsp.statfs(target);
    const bsize = Number(st.bsize) || 4096;
    return {
      freeBytes: Number(st.bavail) * bsize,
      totalBytes: Number(st.blocks) * bsize,
    };
  } catch {
    return null;
  }
}

/**
 * Rileva se il drive è rimovibile. Su Windows usa PowerShell:
 *   Get-Volume -DriveLetter D | Select-Object -ExpandProperty DriveType
 * Valori: "Removable" | "Fixed" | "Network" | "CD-ROM" | "RAM Disk" | "Unknown"
 *
 * Fallback non-Windows: drive != cwd drive root → assume removable (euristica).
 * Safe-fail: ritorna null su qualsiasi errore (non è mai un bloccante).
 */
async function detectDriveType(p) {
  if (process.platform !== 'win32') {
    return null; // Fuori scope su macOS/Linux — ritorna null = "non determinato"
  }
  const letter = getDriveLetter(p);
  if (!letter) return null;

  try {
    const { stdout } = await runProc(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Volume -DriveLetter ${letter} -ErrorAction SilentlyContinue).DriveType`,
      ],
      { timeout: 5_000 },
    );
    const type = String(stdout || '').trim();
    return type || null;
  } catch {
    return null;
  }
}

/**
 * API principale. Usata dal main handler `disk:info`.
 * @param {string} p path (file o directory) per cui ottenere info drive
 * @returns {Promise<{
 *   path: string,
 *   driveLetter: string|null,
 *   driveType: string|null,       // "Removable" | "Fixed" | ... | null
 *   isRemovable: boolean,
 *   freeBytes: number|null,
 *   totalBytes: number|null,
 * }>}
 */
async function getDiskInfo(p) {
  const [space, driveType] = await Promise.all([
    getSpaceInfo(p),
    detectDriveType(p),
  ]);
  return {
    path: String(p || ''),
    driveLetter: getDriveLetter(p),
    driveType,
    isRemovable: driveType === 'Removable',
    freeBytes: space?.freeBytes ?? null,
    totalBytes: space?.totalBytes ?? null,
  };
}

module.exports = { getDiskInfo, getDriveLetter };
