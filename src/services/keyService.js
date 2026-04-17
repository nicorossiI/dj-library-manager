/**
 * src/services/keyService.js
 *
 * Detection chiave musicale via essentia.js (KeyExtractor) + conversione
 * notazione Camelot Wheel (formato Rekordbox).
 *
 * essentia.js è WASM-based, init asincrona (lazy singleton).
 * Fallback graceful: se essentia non si carica, ritorna senza errori e
 * la pipeline procede senza chiave.
 *
 * Esporta: detectKey(filePath), detectKeyIfMissing(track)
 * Dipendenze: essentia.js, bpmService.decodePcmMono, CAMELOT_WHEEL
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { decodePcmMono } = require('./bpmService');
const { toCamelot } = require('../constants/CAMELOT_WHEEL');
const analysisCache = require('./analysisCache');

// ---------------------------------------------------------------------------
// keyfinder-cli path resolution (dev vs packaged) — stesso pattern di fpcalc
// ---------------------------------------------------------------------------

function getKeyfinderCliPath() {
  const isPackaged = (() => {
    try {
      const { app } = require('electron');
      return !!(app && app.isPackaged);
    } catch { return false; }
  })();

  const binName =
    process.platform === 'win32'  ? 'keyfinder-cli.exe' :
    process.platform === 'darwin' ? 'keyfinder-cli-mac' :
    'keyfinder-cli';

  if (isPackaged) {
    return path.join(process.resourcesPath, 'bin', binName);
  }
  return path.join(__dirname, '..', '..', 'assets', 'bin', binName);
}

function keyfinderCliAvailable() {
  try { return fs.existsSync(getKeyfinderCliPath()); } catch { return false; }
}

// ---------------------------------------------------------------------------
// detectKeyKeyfinder — invoca keyfinder-cli.exe con -n camelot
// Output: una singola riga tipo "8A", "11B" (notazione Camelot).
// Timeout 30s per file. Exit 0 + stdout vuoto = nessuna chiave rilevata.
// ---------------------------------------------------------------------------

const KEYFINDER_TIMEOUT_MS = 30_000;

function runKeyfinderCli(filePath) {
  return new Promise((resolve, reject) => {
    const bin = getKeyfinderCliPath();
    if (!fs.existsSync(bin)) {
      return reject(new Error(`keyfinder-cli non trovato: ${bin}`));
    }
    const proc = spawn(bin, ['-n', 'camelot', filePath], { windowsHide: true });
    let stdout = '', stderr = '';
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
      finish(reject, new Error(`keyfinder-cli timeout (${KEYFINDER_TIMEOUT_MS}ms)`));
    }, KEYFINDER_TIMEOUT_MS);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => { clearTimeout(timer); finish(reject, err); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        return finish(reject, new Error(`keyfinder-cli exit ${code}: ${stderr.trim() || 'errore sconosciuto'}`));
      }
      finish(resolve, stdout.trim());
    });
  });
}

// Camelot valido: "1A"..."12A" o "1B"..."12B"
function isValidCamelot(s) {
  return /^(?:[1-9]|1[0-2])[AB]$/i.test(String(s || '').trim());
}

async function detectKeyViaKeyfinder(filePath) {
  const out = await runKeyfinderCli(filePath);
  const camelot = String(out).trim().toUpperCase();
  if (!camelot) throw new Error('keyfinder-cli: output vuoto (chiave non rilevata)');
  if (!isValidCamelot(camelot)) {
    throw new Error(`keyfinder-cli: output non-Camelot "${camelot}"`);
  }
  return { camelot, keyFull: '', strength: 1, source: 'keyfinder-cli' };
}

// ─────────────────────────────────────────────────────────────────────
// Lazy singleton init essentia.js (WASM)
// ─────────────────────────────────────────────────────────────────────

let _essentiaPromise = null;
let _essentiaFailed = false;

async function getEssentia() {
  if (_essentiaFailed) return null;
  if (_essentiaPromise) return _essentiaPromise;

  _essentiaPromise = (async () => {
    try {
      const Essentia = require('essentia.js');
      // Load WASM. essentia.js v0.1.3 expone EssentiaWASM async constructor.
      const EssentiaWASM = Essentia.EssentiaWASM;
      const Essentia_class = Essentia.Essentia;
      if (!EssentiaWASM || !Essentia_class) {
        throw new Error('essentia.js export non riconosciuto');
      }
      // EssentiaWASM è un Promise / module init
      const wasm = await (typeof EssentiaWASM === 'function' ? EssentiaWASM() : EssentiaWASM);
      const ess = new Essentia_class(wasm);
      return ess;
    } catch (err) {
      _essentiaFailed = true;
      console.warn('[keyService] essentia.js init fallita:', err.message);
      return null;
    }
  })();

  return _essentiaPromise;
}

// ─────────────────────────────────────────────────────────────────────
// detectKey — analizza file audio → {camelot, key, scale, strength}
// ─────────────────────────────────────────────────────────────────────

async function detectKey(filePath, { maxSeconds = 60 } = {}) {
  const ess = await getEssentia();
  if (!ess) throw new Error('essentia.js non disponibile');

  const audio = await decodePcmMono(filePath, { maxSeconds });
  if (!audio || audio.length < 44100 * 5) {
    throw new Error(`audio troppo corto (${audio?.length || 0} samples)`);
  }

  // Essentia richiede VectorFloat (custom WASM type)
  const vec = ess.arrayToVector(audio);
  let result;
  try {
    result = ess.KeyExtractor(vec);
  } finally {
    // Cleanup WASM memory
    if (vec && typeof vec.delete === 'function') {
      try { vec.delete(); } catch { /* noop */ }
    }
  }

  if (!result || !result.key) throw new Error('KeyExtractor: nessun risultato');
  const camelot = toCamelot({ key: result.key, scale: result.scale });
  return {
    camelot,                           // "8B" o null
    keyFull: `${result.key} ${result.scale}`, // "C major"
    key: result.key,                   // "C"
    scale: result.scale,               // "major"
    strength: result.strength || 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// detectKeyIfMissing — pipeline helper, muta track in-place
// ─────────────────────────────────────────────────────────────────────

async function detectKeyIfMissing(track) {
  if (!track || !track.filePath) return track;
  if (track.key) return track; // già presente (Camelot)

  // Persistent cache hit → salta calcolo
  const cached = analysisCache.getCached(track.filePath);
  if (cached && cached.key) {
    track.key = cached.key;
    track.keyFull = cached.keyFull || '';
    track.keyStrength = cached.keyStrength || 0;
    console.log('[CACHE HIT key]', track.fileName);
    return track;
  }

  // Cascata: (1) keyfinder-cli (libkeyfinder, stessa libreria di Mixxx)
  //         (2) essentia.js (fallback WASM)
  let r = null;
  let errKf = null;

  if (keyfinderCliAvailable()) {
    try {
      r = await detectKeyViaKeyfinder(track.filePath);
    } catch (err) {
      errKf = err.message;
    }
  }

  if (!r) {
    try {
      r = await detectKey(track.filePath);
    } catch (err) {
      track.keyError = errKf ? `keyfinder: ${errKf} | essentia: ${err.message}` : err.message;
      return track;
    }
  }

  if (r && r.camelot) {
    track.key = r.camelot;                       // "8B"
    track.keyFull = r.keyFull || '';             // "C major" (solo essentia)
    track.keyStrength = r.strength ?? 0;
    track.keySource = r.source || 'essentia.js'; // tracciabilità
    track.keyDetected = true;
    analysisCache.setCached(track.filePath, {
      key: r.camelot,
      keyFull: r.keyFull || '',
      keyStrength: r.strength ?? 0,
      keySource: r.source || 'essentia.js',
    });
  }
  return track;
}

// ─────────────────────────────────────────────────────────────────────
// API spec: detectKeyAll(tracks, onProgress)
// ─────────────────────────────────────────────────────────────────────

async function detectKeyAll(tracks, onProgress) {
  const list = tracks || [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    await detectKeyIfMissing(t);
    if (typeof onProgress === 'function') {
      try { onProgress(i + 1, list.length, t); } catch { /* noop */ }
    }
  }
  return list;
}

module.exports = {
  detectKey,                  // essentia.js diretto (legacy)
  detectKeyViaKeyfinder,      // keyfinder-cli diretto
  detectKeyIfMissing,         // cascata keyfinder → essentia
  detectKeyAll,
  getEssentia,
  getKeyfinderCliPath,
  keyfinderCliAvailable,
};
