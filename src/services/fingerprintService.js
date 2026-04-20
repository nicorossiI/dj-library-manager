/**
 * src/services/fingerprintService.js
 *
 * Fingerprinting acustico con Chromaprint (fpcalc) per rilevamento doppioni OFFLINE.
 *
 * Strategia:
 *   - fpcalc estrae un fingerprint acustico basato sul contenuto audio reale.
 *   - Due file con stesso audio ma nomi/tag diversi → fingerprint quasi identici.
 *   - Il confronto usa la distanza di Hamming bit-a-bit sul buffer decodificato
 *     da base64 url-safe (algoritmo analogo a quello di MusicBrainz Picard).
 *
 * Binario:
 *   - Dev:  <repo>/assets/bin/fpcalc(.exe|-mac)
 *   - Prod: process.resourcesPath/bin/fpcalc(.exe|-mac)   (via extraResources)
 *
 * Esporta (API spec):
 *   fingerprintTrack(track)
 *   fingerprintSegment(filePath, startSeconds, durationSeconds)
 *   fingerprintAll(tracks, onProgress)
 *   compareFingerprints(fp1, fp2)
 *   findAcousticDuplicates(occurrenceList)
 * Esporta (retro-compat):
 *   computeFingerprint(filePath)
 *   getFpcalcPath()
 *
 * Dipendenze: child_process, fs, path, os, crypto, ffmpegService
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { runProc } = require('../utils/runProc');

const { CONFIG } = require('../constants/CONFIG');
const { extractSegment } = require('./ffmpegService');
const analysisCache = require('./analysisCache');

// ---------------------------------------------------------------------------
// Path resolution (dev vs packaged)
// ---------------------------------------------------------------------------

function getFpcalcPath() {
  const isPackaged = (() => {
    try {
      const { app } = require('electron');
      return !!(app && app.isPackaged);
    } catch { return false; }
  })();

  const binName =
    process.platform === 'win32'  ? 'fpcalc.exe' :
    process.platform === 'darwin' ? 'fpcalc-mac' :
    'fpcalc';

  if (isPackaged) {
    return path.join(process.resourcesPath, 'bin', binName);
  }
  return path.join(__dirname, '..', '..', 'assets', 'bin', binName);
}

// ---------------------------------------------------------------------------
// fpcalc runner
// ---------------------------------------------------------------------------

const DEFAULT_LENGTH_SEC = CONFIG.mix?.fingerprintSeconds || 120;

const FPCALC_TIMEOUT_MS = 30_000;

async function runFpcalc(filePath, { length = DEFAULT_LENGTH_SEC, timeoutMs = FPCALC_TIMEOUT_MS } = {}) {
  const bin = getFpcalcPath();
  if (!fs.existsSync(bin)) {
    throw new Error(
      `fpcalc non trovato: ${bin}\n` +
      'Scarica Chromaprint 1.5.x da https://acoustid.org/chromaprint ' +
      'e metti fpcalc.exe in assets/bin/'
    );
  }
  const args = ['-json'];
  if (length > 0) args.push('-length', String(length));
  args.push(filePath);

  const { stdout } = await runProc(bin, args, { timeout: timeoutMs });
  try {
    const json = JSON.parse(stdout);
    return {
      duration: Number(json.duration) || 0,
      fingerprint: String(json.fingerprint || ''),
    };
  } catch (e) {
    throw new Error(`fpcalc output non parsabile: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory cache (invalidata da mtime del file)
// ---------------------------------------------------------------------------

const _cache = new Map(); // filePath → { mtime, length, fingerprint, duration }

async function cacheKey(filePath, length) {
  try {
    const st = await fsp.stat(filePath);
    return { key: `${filePath}::${length}`, mtime: st.mtimeMs };
  } catch {
    return { key: `${filePath}::${length}`, mtime: 0 };
  }
}

async function getCachedOrCompute(filePath, { length = DEFAULT_LENGTH_SEC } = {}) {
  const { key, mtime } = await cacheKey(filePath, length);
  const hit = _cache.get(key);
  if (hit && hit.mtime === mtime) return hit;
  const fp = await runFpcalc(filePath, { length });
  const entry = { mtime, length, fingerprint: fp.fingerprint, duration: fp.duration };
  _cache.set(key, entry);
  return entry;
}

function clearCache() { _cache.clear(); }

// ---------------------------------------------------------------------------
// API: fingerprintTrack
// ---------------------------------------------------------------------------

/**
 * Calcola fingerprint acustico di un Track.
 * Se durata > soglia mix, riduciamo length a CONFIG.mix.fingerprintSeconds
 * (default 120s) per evitare che un set di 2h blocchi tutto.
 * Il Track viene mutato in-place con .fingerprint e .fingerprintDuration.
 */
async function fingerprintTrack(track) {
  if (!track || !track.filePath) {
    throw new Error('fingerprintTrack: track.filePath mancante');
  }

  // Persistent cache lookup (fingerprint + eventuali bpm/key già calcolati)
  const cached = analysisCache.getCached(track.filePath);
  if (cached && cached.fingerprint) {
    track.fingerprint = cached.fingerprint;
    track.fingerprintDuration = cached.fingerprintDuration || 0;
    if (cached.bpm && !track.bpm) track.bpm = cached.bpm;
    if (cached.key && !track.key) {
      track.key = cached.key;
      track.keyFull = cached.keyFull || '';
    }
    track.status = 'fingerprinted';
    console.log('[CACHE HIT fp]', track.fileName);
    return track;
  }

  const isLong = (track.duration || 0) > (CONFIG.mix?.minDurationMinutes || 10) * 60;
  const length = isLong ? (CONFIG.mix?.fingerprintSeconds || 120) : DEFAULT_LENGTH_SEC;
  try {
    const res = await getCachedOrCompute(track.filePath, { length });
    track.fingerprint = res.fingerprint;
    track.fingerprintDuration = res.duration;
    track.status = 'fingerprinted';
    analysisCache.setCached(track.filePath, {
      fingerprint: res.fingerprint,
      fingerprintDuration: res.duration,
    });
    return track;
  } catch (err) {
    // File corrotti / formato non supportato / timeout: skip con log sul track
    track.status = 'error';
    track.errorMessage = `fingerprint: ${err.message}`;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// API: fingerprintSegment
// ---------------------------------------------------------------------------

/**
 * Estrae un segmento del file con ffmpeg e ne calcola il fingerprint.
 * Ritorna la stringa fingerprint (Chromaprint base64 url-safe).
 */
async function fingerprintSegment(filePath, startSeconds, durationSeconds = 30) {
  if (!filePath) throw new Error('fingerprintSegment: filePath mancante');
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-fp-seg-'));
  const tmpOut = path.join(tmpDir, 'segment.mp3');
  try {
    await extractSegment(filePath, startSeconds, durationSeconds, tmpOut);
    const res = await runFpcalc(tmpOut, { length: Math.ceil(durationSeconds) });
    return res.fingerprint;
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// API: fingerprintAll (batch)
// ---------------------------------------------------------------------------

/**
 * Fingerprint su tutto l'array; non blocca in caso di errore su singoli track
 * (scrive errorMessage e prosegue). Esegue sequenziale per non saturare CPU/IO.
 */
async function fingerprintAll(tracks, onProgress) {
  const list = tracks || [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    try {
      await fingerprintTrack(t);
      t.status = (t.status === 'pending' || !t.status) ? 'fingerprinted' : t.status;
    } catch (err) {
      t.errorMessage = `fingerprint: ${err.message}`;
    }
    if (typeof onProgress === 'function') {
      try { onProgress(i + 1, list.length, t); } catch { /* noop */ }
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// Fingerprint similarity (Hamming su decoded base64)
// ---------------------------------------------------------------------------

/**
 * fpcalc ritorna fingerprint in base64 url-safe.
 * Convertiamo in buffer di byte e confrontiamo i bit 1-a-1.
 */
function base64UrlDecode(s) {
  if (!s) return Buffer.alloc(0);
  const std = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = std.length % 4;
  const padded = pad ? std + '='.repeat(4 - pad) : std;
  return Buffer.from(padded, 'base64');
}

// Popcount (Brian Kernighan / bit-twiddling)
function popcount8(x) {
  x = x - ((x >> 1) & 0x55);
  x = (x & 0x33) + ((x >> 2) & 0x33);
  return (x + (x >> 4)) & 0x0F;
}

function hammingDistanceBits(bufA, bufB) {
  const common = Math.min(bufA.length, bufB.length);
  let diffBits = 0;
  for (let i = 0; i < common; i++) {
    diffBits += popcount8(bufA[i] ^ bufB[i]);
  }
  // I byte residui (lunghezze diverse) contano come completamente diversi
  diffBits += Math.abs(bufA.length - bufB.length) * 8;
  return diffBits;
}

/**
 * Similarità 0..1 (1 = identici).
 *   > 0.90 → stesso file (acoustic_exact)
 *   0.70..0.90 → versione simile / edit (acoustic_similar)
 *   < 0.70 → non correlati
 */
function compareFingerprints(fp1, fp2) {
  if (!fp1 || !fp2) return 0;
  if (fp1 === fp2) return 1;
  const a = base64UrlDecode(fp1);
  const b = base64UrlDecode(fp2);
  const totalBits = Math.max(a.length, b.length) * 8;
  if (totalBits === 0) return 0;
  const diff = hammingDistanceBits(a, b);
  return Math.max(0, 1 - diff / totalBits);
}

// ---------------------------------------------------------------------------
// API: findAcousticDuplicates
// ---------------------------------------------------------------------------

const EXACT_THRESHOLD = 0.90;
const SIMILAR_THRESHOLD = 0.70;
const LENGTH_TOLERANCE = 0.25; // +/- 25% sulla lunghezza fingerprint byte

/**
 * Trova coppie acusticamente duplicate in una lista di "occurrence".
 *
 * Un'occurrence rappresenta una singola entità fingerprintabile:
 *   - una traccia intera (isMixSegment=false)
 *   - un segmento riconosciuto dentro un mix (isMixSegment=true)
 *
 * Shape minima richiesta per ogni occurrence:
 *   { fingerprint: string, isMixSegment?: boolean, isMashupOrEdit?: boolean, ... }
 *
 * Skip rules:
 *   - Occurrence senza fingerprint
 *   - Stessa identità (stesso reference object)
 *   - Accoppiamenti mashup/edit ↔ originale: una traccia esplicitamente
 *     marcata come mashup/edit NON è un "doppione" della traccia originale,
 *     è una variante legittima. Confrontiamo solo:
 *       originale ↔ originale   oppure   mashup ↔ mashup
 *
 * Ottimizzazione:
 *   - Bucketing per lunghezza del buffer decodificato (tolleranza ±25%)
 *   - Lista ordinata per lunghezza + early-exit sulla sliding window
 *     (Chromaprint fingerprint è lineare con la durata audio).
 *
 * @param {Array<object>} occurrenceList
 * @returns {Array<{occurrenceA, occurrenceB, similarity, matchType}>}
 */
function findAcousticDuplicates(occurrenceList) {
  const prepared = (occurrenceList || [])
    .filter(o => o && o.fingerprint)
    .map(o => ({
      occ: o,
      buf: base64UrlDecode(o.fingerprint),
    }))
    .filter(x => x.buf.length > 0);

  prepared.sort((a, b) => a.buf.length - b.buf.length);

  const results = [];
  for (let i = 0; i < prepared.length; i++) {
    const A = prepared[i];
    const aLen = A.buf.length;
    const aMash = !!A.occ.isMashupOrEdit;

    for (let j = i + 1; j < prepared.length; j++) {
      const B = prepared[j];
      const bLen = B.buf.length;

      // Early-exit: tutti i successivi sono ancora più lunghi
      if (aLen > 0 && (bLen - aLen) / aLen > LENGTH_TOLERANCE) break;

      // Stessa identità → skip (non confrontare occurrence con se stessa
      // se la lista contiene duplicati di riferimento)
      if (A.occ === B.occ) continue;

      // Skip mashup/edit vs originale (solo accoppiamenti omogenei)
      if (aMash !== !!B.occ.isMashupOrEdit) continue;

      const diff = hammingDistanceBits(A.buf, B.buf);
      const totalBits = Math.max(aLen, bLen) * 8;
      if (totalBits === 0) continue;
      const sim = 1 - diff / totalBits;

      if (sim >= SIMILAR_THRESHOLD) {
        results.push({
          occurrenceA: A.occ,
          occurrenceB: B.occ,
          similarity: Math.max(0, sim),
          matchType: sim >= EXACT_THRESHOLD ? 'acoustic_exact' : 'acoustic_similar',
        });
      }
    }
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results;
}

// ---------------------------------------------------------------------------
// Retrocompat: API usata dal vecchio ipcHandlers / tests
// ---------------------------------------------------------------------------

/**
 * Ritorna { duration, fingerprint } per un singolo file (vecchia API).
 * Usa la stessa cache interna di fingerprintTrack.
 */
async function computeFingerprint(filePath) {
  const res = await getCachedOrCompute(filePath);
  return { duration: res.duration, fingerprint: res.fingerprint };
}

module.exports = {
  // spec
  fingerprintTrack,
  fingerprintSegment,
  fingerprintAll,
  compareFingerprints,
  findAcousticDuplicates,
  // utility
  getFpcalcPath,
  clearCache,
  // retro-compat
  computeFingerprint,
};
