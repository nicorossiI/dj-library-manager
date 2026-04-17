/**
 * src/services/aiGenreService.js
 *
 * Classificazione genere BASE da modello DiscogsEffNet.
 *
 * Strategia:
 *   1. Inferenza LOCALE via `scripts/ai_classify.py` (Python + TF).
 *      Preprocessing mel-spectrogram approssimato ma senza costi/rete.
 *   2. Se locale non disponibile oppure confidence < 30% →
 *      Replicate API (mtg/effnet-discogs) che fa preprocessing corretto
 *      lato server. Richiede REPLICATE_TOKEN (env var o store).
 *   3. Se anche Replicate non configurato/disponibile → null (il classifier
 *      standard fa il suo lavoro con keyword/artists).
 *
 * API:
 *   classifyGenreFromAudio(track) → { genre, confidence, top, source } | null
 *   isLocalAvailable()            → boolean (modello+Python ci sono)
 *   hasReplicateToken()           → boolean (token nel env/store)
 *   setReplicateToken(token)      → void (set env var runtime)
 *
 * Dipendenze: axios, child_process, fs, path
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let _axios = null;
function getAxios() {
  if (_axios) return _axios;
  try { _axios = require('axios'); } catch { _axios = null; }
  return _axios;
}

const MODEL_DIR = path.join(__dirname, '..', '..', 'assets', 'models');
const MODEL_PB = path.join(MODEL_DIR, 'discogs-effnet-bs64-1.pb');
const PY_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'ai_classify.py');

// Soglia minima sul risultato locale. Sotto questa, cade su Replicate.
const MIN_LOCAL_CONFIDENCE = 30;

// Cache del check "Python + TF disponibili" (evita spawn ad ogni chiamata)
let _localCache = null;
let _pythonCmd = null;

function isLocalAvailable() {
  if (_localCache !== null) return _localCache;
  if (!fs.existsSync(MODEL_PB) || !fs.existsSync(PY_SCRIPT)) {
    return (_localCache = false);
  }
  for (const pv of ['-3.11', '-3.12']) {
    const r = spawnSync('py', [pv, '-c', 'import tensorflow'], { shell: false });
    if (r.status === 0) {
      _pythonCmd = { cmd: 'py', ver: pv };
      return (_localCache = true);
    }
  }
  return (_localCache = false);
}

function hasReplicateToken() {
  return !!(process.env.REPLICATE_TOKEN && process.env.REPLICATE_TOKEN.trim());
}

function setReplicateToken(token) {
  if (token && String(token).trim()) {
    process.env.REPLICATE_TOKEN = String(token).trim();
  } else {
    delete process.env.REPLICATE_TOKEN;
  }
}

// ---------------------------------------------------------------------------
// Discogs label → nostro genere
// ---------------------------------------------------------------------------

const DISCOGS_MAP = Object.freeze({
  'afro house':     'afrohouse',
  'afrobeat':       'afrohouse',
  'afrobeats':      'afrohouse',
  'tribal house':   'afrohouse',
  'tech house':     'techhouse',
  'deep house':     'deephouse',
  'house':          'house',
  'funky house':    'house',
  'disco house':    'house',
  'progressive house': 'house',
  'reggaeton':      'reggaeton',
  'latin hip hop':  'reggaeton',
  'latin hip-hop':  'reggaeton',
  'latin':          'reggaeton',
  'dembow':         'dembow',
  'mambo':          'dembow',
  'bachata':        'bachata',
  'salsa':          'salsa',
  'tropical':       'salsa',
  'cumbia':         'salsa',
  'merengue':       'salsa',
  'hip hop':        'hiphop',
  'hip-hop':        'hiphop',
  'rap':            'hiphop',
  'trap':           'hiphop',
  'techno':         'techno',
  'minimal':        'techno',
  'trance':         'trance',
});

function mapDiscogsLabel(label) {
  if (!label) return null;
  // "Parent---Sub" → preferisci sub, altrimenti parent, poi substring
  const raw = String(label).toLowerCase().trim();
  let parent = null, sub = null;
  if (raw.includes('---')) {
    const parts = raw.split('---');
    parent = parts[0].trim();
    sub = parts.slice(1).join(' ').trim();
  }
  if (sub && DISCOGS_MAP[sub]) return DISCOGS_MAP[sub];
  if (parent && DISCOGS_MAP[parent]) return DISCOGS_MAP[parent];
  if (DISCOGS_MAP[raw]) return DISCOGS_MAP[raw];
  for (const [k, v] of Object.entries(DISCOGS_MAP)) {
    if (raw.includes(k)) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// LOCAL — subprocess Python
// ---------------------------------------------------------------------------

async function tryLocalClassification(track, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120_000;
  if (!isLocalAvailable()) return null;
  if (!track?.filePath || !fs.existsSync(track.filePath)) return null;

  return await new Promise((resolve) => {
    const proc = spawn(_pythonCmd.cmd, [_pythonCmd.ver, PY_SCRIPT, track.filePath], {
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const to = setTimeout(() => { try { proc.kill(); } catch { /* noop */ } }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', () => { clearTimeout(to); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(to);
      if (code !== 0 && !stdout) {
        if (stderr) console.warn('[AI Genre local] stderr:', stderr.slice(-300));
        return resolve(null);
      }
      try {
        const result = JSON.parse(stdout.trim().split('\n').pop());
        if (!result.ok || !result.genre_mapped) return resolve(null);
        return resolve({
          genre: result.genre_mapped,
          confidence: result.confidence,
          top: (result.top || []).map(t => `${t.label} (${Math.round(t.score * 100)}%)`),
          source: 'ai_local',
        });
      } catch {
        return resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// REPLICATE API — preprocessing corretto lato server
// ---------------------------------------------------------------------------

/**
 * Modello: mtg/effnet-discogs (DiscogsEffNet hostato da MTG su Replicate).
 * Richiede REPLICATE_TOKEN in env var (oppure settato via setReplicateToken).
 * Polling: richiesta async + loop GET finché status === 'succeeded' o timeout.
 *
 * Struttura risposta prevista: output = array di { label, score } o
 * oggetto con predictions. Gestiamo entrambi i formati per robustezza.
 */
async function tryReplicateApi(track, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60_000;
  const axios = getAxios();
  if (!axios) return null;
  if (!hasReplicateToken()) return null;
  if (!track?.filePath || !fs.existsSync(track.filePath)) return null;

  const token = process.env.REPLICATE_TOKEN.trim();
  const headers = {
    'Authorization': `Token ${token}`,
    'Content-Type': 'application/json',
  };

  try {
    const audioBuffer = fs.readFileSync(track.filePath);
    const base64Audio = audioBuffer.toString('base64');
    const ext = String(track.filePath.split('.').pop() || 'mp3').toLowerCase();
    const mimeType =
      ext === 'wav' ? 'audio/wav' :
      ext === 'flac' ? 'audio/flac' :
      ext === 'm4a' || ext === 'aac' ? 'audio/aac' : 'audio/mpeg';

    const startRes = await axios.post(
      'https://api.replicate.com/v1/models/mtg/effnet-discogs/predictions',
      { input: { audio: `data:${mimeType};base64,${base64Audio}`, top_k: 5 } },
      { headers, timeout: 30_000, validateStatus: s => s < 500 },
    );
    if (startRes.status >= 400) {
      console.warn('[AI Genre Replicate] start error', startRes.status, startRes.data?.detail || startRes.data);
      return null;
    }

    let prediction = startRes.data;
    const deadline = Date.now() + timeoutMs;
    while (
      prediction?.status !== 'succeeded' &&
      prediction?.status !== 'failed' &&
      prediction?.status !== 'canceled' &&
      Date.now() < deadline
    ) {
      await new Promise(r => setTimeout(r, 1500));
      const poll = await axios.get(
        `https://api.replicate.com/v1/predictions/${prediction.id}`,
        { headers, timeout: 15_000, validateStatus: s => s < 500 },
      );
      if (poll.status >= 400) break;
      prediction = poll.data;
    }

    if (prediction?.status !== 'succeeded') {
      if (prediction?.status) console.warn('[AI Genre Replicate]', prediction.status, prediction.error || '');
      return null;
    }

    // output può essere: array [{label,score}] oppure oggetto {predictions:[...]}
    let items = [];
    const out = prediction.output;
    if (Array.isArray(out)) {
      items = out;
    } else if (out && Array.isArray(out.predictions)) {
      items = out.predictions;
    }
    if (items.length === 0) return null;

    // Normalizza item shape
    items = items
      .map(x => ({
        label: x.label || x.class || x.name,
        score: Number(x.score ?? x.probability ?? x.confidence ?? 0),
      }))
      .filter(x => x.label && Number.isFinite(x.score))
      .sort((a, b) => b.score - a.score);

    for (const t of items) {
      const mapped = mapDiscogsLabel(t.label);
      if (mapped) {
        return {
          genre: mapped,
          confidence: Math.round(t.score * 100),
          top: items.slice(0, 5).map(x => `${x.label} (${Math.round(x.score * 100)}%)`),
          source: 'replicate_effnet',
        };
      }
    }
    return null;
  } catch (err) {
    console.warn('[AI Genre Replicate] error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pubblico: classifyGenreFromAudio con fallback a cascata
// ---------------------------------------------------------------------------

async function classifyGenreFromAudio(track, opts = {}) {
  // 1) Locale
  const local = await tryLocalClassification(track, opts);
  if (local && local.confidence >= MIN_LOCAL_CONFIDENCE) return local;

  // 2) Replicate (solo se configurato)
  if (hasReplicateToken()) {
    const remote = await tryReplicateApi(track, opts);
    if (remote) return remote;
  }

  // 3) Nessun risultato affidabile
  return local || null;
}

// Back-compat per chiamanti esistenti
function isAvailable() {
  return isLocalAvailable() || hasReplicateToken();
}

module.exports = {
  classifyGenreFromAudio,
  isAvailable,
  isLocalAvailable,
  hasReplicateToken,
  setReplicateToken,
  mapDiscogsLabel,
};
