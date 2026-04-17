/**
 * src/services/shazamService.js
 *
 * Terzo livello della cascata di riconoscimento (dopo ACRCloud e AcoustID).
 * Shazam usa fingerprinting neurale sulla melodia vocale: riconosce anche
 * canzoni con base completamente modificata (afrohouse edit, techhouse blend).
 *
 * Libreria: node-shazam (ESM). Accesso via dynamic import + singleton.
 * Gratis, nessuna API key, nessuna registrazione.
 *
 * API:
 *   recognizeSingle(track)                                → parsedResult|null
 *   recognizeAtOffset(filePath, offsetSeconds, dur=12)    → parsedResult|null
 *   testConnection()                                      → {ok, message}
 *   parseShazamResult(result)                             → parsedResult|null
 *
 * Struttura parsedResult:
 *   { title, artist, shazamKey, coverArtUrl, genre, confidence, accuracy, source }
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Singleton + rate limit
// ---------------------------------------------------------------------------

let _shazam = null;
let _lastRequestTime = 0;
const MIN_DELAY_MS = 1500;

async function getShazam() {
  if (_shazam) return _shazam;
  try {
    const mod = await import('node-shazam');
    const Shazam = mod.Shazam || mod.default?.Shazam || mod.default;
    if (!Shazam) throw new Error('Shazam class not found in module');
    _shazam = new Shazam();
    console.log('[Shazam] Istanza inizializzata');
  } catch (e) {
    console.error('[Shazam] Errore init:', e.message);
    throw e;
  }
  return _shazam;
}

async function waitForRateLimit() {
  const now = Date.now();
  const elapsed = now - _lastRequestTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise(r => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  _lastRequestTime = Date.now();
}

// ---------------------------------------------------------------------------
// Parsing risposta Shazam
// ---------------------------------------------------------------------------

/**
 * accuracy Shazam (distanza 0-1, più bassa = migliore) → confidence 0-95.
 */
function accuracyToConfidence(accuracy) {
  if (accuracy === undefined || accuracy === null) return 70;
  const clamped = Math.max(0, Math.min(Number(accuracy) || 0, 1));
  return Math.min(Math.round((1 - clamped) * 100), 95);
}

/**
 * Estrae {title, artist, ...} dalla risposta Shazam.
 * ATTENZIONE: artista è in result.track.subtitle, NON result.track.artist.
 */
function parseShazamResult(result) {
  if (!result) return null;
  const matches = Array.isArray(result.matches) ? result.matches : [];
  if (matches.length === 0) return null;
  const track = result.track;
  if (!track) return null;

  const accuracy = result.location?.accuracy;
  return {
    title: track.title || null,
    artist: track.subtitle || null,      // subtitle = artista in Shazam
    shazamKey: track.key || null,
    coverArtUrl: track.images?.coverarthq || track.images?.coverart || null,
    genre: track.genres?.primary || null,
    confidence: accuracyToConfidence(accuracy),
    accuracy: accuracy,
    source: 'shazam',
  };
}

// ---------------------------------------------------------------------------
// recognizeSingle
// ---------------------------------------------------------------------------

/**
 * Identifica una singola traccia inviando l'intero file a Shazam.
 * Usato come fallback quando ACRCloud e AcoustID non trovano.
 *
 * @param {Track|{filePath:string, fileName?:string}} track
 * @returns {Promise<object|null>} parsedResult o null
 */
async function recognizeSingle(track) {
  if (!track?.filePath || !fs.existsSync(track.filePath)) return null;

  try {
    await waitForRateLimit();
    const shazam = await getShazam();

    const fname = track.fileName || path.basename(track.filePath);
    console.log('[Shazam] Riconosco:', fname);

    const result = await shazam.recognise(track.filePath, 'en-US');
    const parsed = parseShazamResult(result);
    if (parsed) {
      console.log(`[Shazam] OK ${parsed.artist} - ${parsed.title} (${parsed.confidence}%)`);
    } else {
      console.log('[Shazam] Non trovato:', fname);
    }
    return parsed;
  } catch (e) {
    const fname = track?.fileName || (track?.filePath ? path.basename(track.filePath) : '?');
    console.warn('[Shazam] Errore recognizeSingle:', fname, e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// recognizeAtOffset — per segmenti di mix
// ---------------------------------------------------------------------------

/**
 * Estrae N secondi da un file audio e li invia a Shazam.
 * Usato dal mix analyzer: Shazam è gratis e illimitato, quindi motore
 * primario per identificare i segmenti. ACRCloud resta come fallback.
 *
 * @param {string} filePath         - file mix di origine
 * @param {number} offsetSeconds    - punto di partenza
 * @param {number} [durationSeconds=12]
 * @returns {Promise<object|null>}
 */
async function recognizeAtOffset(filePath, offsetSeconds, durationSeconds = 12) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  let ffmpegPath = null;
  try { ffmpegPath = require('ffmpeg-static'); } catch { /* noop */ }
  if (!ffmpegPath) return null;

  const tmpFile = path.join(
    os.tmpdir(),
    `shazam_seg_${Date.now()}_${offsetSeconds}_${process.pid}.wav`,
  );

  try {
    // Estrai segmento WAV 44.1kHz mono (Shazam preferisce sample rate standard)
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        '-ss', String(Math.max(0, offsetSeconds)),
        '-t', String(durationSeconds),
        '-i', filePath,
        '-ar', '44100',
        '-ac', '1',
        '-f', 'wav',
        '-y', tmpFile,
      ], { windowsHide: true });

      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-200)}`));
      });
      proc.on('error', reject);
    });

    if (!fs.existsSync(tmpFile)) return null;

    await waitForRateLimit();
    const shazam = await getShazam();
    const result = await shazam.recognise(tmpFile, 'en-US');
    return parseShazamResult(result);
  } catch (e) {
    console.warn(`[Shazam] Errore segmento ${offsetSeconds}s:`, e.message);
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

/**
 * Verifica che il modulo ESM sia caricabile e l'istanza creabile.
 * Non fa vere richieste di rete (Shazam non ha endpoint "ping").
 */
async function testConnection() {
  try {
    await getShazam();
    return { ok: true, message: 'Shazam disponibile (gratuito, illimitato)' };
  } catch (e) {
    return { ok: false, message: `Shazam non disponibile: ${e.message}` };
  }
}

module.exports = {
  recognizeSingle,
  recognizeAtOffset,
  testConnection,
  parseShazamResult,
  accuracyToConfidence,
};
