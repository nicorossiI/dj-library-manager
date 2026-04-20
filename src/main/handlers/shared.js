/**
 * src/main/handlers/shared.js
 *
 * Helper condivisi tra i moduli handler: ok/fail, pct, validateOutputPath,
 * factory per send/emitLog/emitAnalysisProgress.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const ok = (data) => ({ ok: true, data });
const fail = (err) => ({ ok: false, error: String(err?.message || err) });

// Path di sistema rifiutati come sourceFolder / organizeOutputRoot.
const FORBIDDEN_PREFIXES = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\System32',
  '/usr', '/bin', '/sbin', '/etc', '/System', '/Library',
];

function validateOutputPath(p, { mustExist = true } = {}) {
  if (!p || !String(p).trim()) return 'Percorso non specificato';
  const normalized = path.resolve(String(p).trim());

  if (/^[A-Za-z]:[\\/]?$/.test(normalized) || normalized === '/') {
    return 'Non puoi usare la root del disco come cartella';
  }

  const low = normalized.toLowerCase();
  for (const f of FORBIDDEN_PREFIXES) {
    if (low.startsWith(f.toLowerCase())) {
      return `Cartella di sistema non consentita: ${normalized}`;
    }
  }

  if (mustExist && !fs.existsSync(normalized)) {
    return `Cartella non trovata: ${normalized}`;
  }

  return null;
}

function pct(done, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function makeSendEvent(getMainWindow) {
  return (channel, payload) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
}

function makeEmitLog(send) {
  return (level, icon, message) => {
    send('library:log', { level, icon, message, ts: Date.now() });
  };
}

function makeEmitAnalysisProgress(send) {
  return ({ phase, phaseProgress, phaseLabel, currentFile }) => {
    const totalPhases = 4;
    const overallPercent = Math.min(100, Math.round(((phase - 1) * 25) + (phaseProgress * 0.25)));
    send('analysis:progress', {
      phase, totalPhases, phaseProgress, phaseLabel, currentFile, overallPercent,
    });
    send('library:progress', {
      phase: ['', 'metadata', 'fingerprint', 'acr', 'classify'][phase] || 'phase',
      done: phaseProgress, total: 100,
      label: phaseLabel, current: currentFile,
    });
  };
}

module.exports = {
  ok, fail, pct,
  FORBIDDEN_PREFIXES, validateOutputPath,
  makeSendEvent, makeEmitLog, makeEmitAnalysisProgress,
};
