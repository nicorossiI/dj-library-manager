/**
 * src/services/bpmService.js
 *
 * BPM detection OFFLINE via music-tempo.
 * Decodifica audio con ffmpeg (PCM f32le mono 44100 Hz) → analizza con
 * music-tempo → ritorna BPM intero. Fallback se decode fallisce.
 *
 * Esporta: detectBpm(filePath), detectBpmIfMissing(track), decodePcmMono
 * Dipendenze: music-tempo, ffmpeg-static, child_process
 */

'use strict';

const { spawn } = require('child_process');
const analysisCache = require('./analysisCache');

// ffmpeg-static path, gestione asar.unpacked per packaging
let ffmpegPath = null;
function getFfmpegPath() {
  if (ffmpegPath) return ffmpegPath;
  let p = require('ffmpeg-static');
  if (typeof p === 'string' && p.includes('app.asar')) {
    p = p.replace('app.asar', 'app.asar.unpacked');
  }
  ffmpegPath = p;
  return p;
}

// music-tempo lazy load
let _MusicTempo = null;
function getMusicTempo() {
  if (_MusicTempo) return _MusicTempo;
  const mod = require('music-tempo');
  // music-tempo esporta la classe come default (CJS): module.exports = MusicTempo
  _MusicTempo = (typeof mod === 'function') ? mod : (mod.default || mod.MusicTempo || mod);
  return _MusicTempo;
}

// ─────────────────────────────────────────────────────────────────────
// decodePcmMono — ffmpeg → Float32Array PCM mono 44100 Hz
// ─────────────────────────────────────────────────────────────────────

function decodePcmMono(filePath, { sampleRate = 44100, maxSeconds = 120 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = getFfmpegPath();
    if (!bin) return reject(new Error('ffmpeg-static path non risolto'));

    // Limitiamo la durata analizzata a maxSeconds per velocità (BPM stabile dopo ~60s)
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', filePath,
      '-t', String(maxSeconds),
      '-f', 'f32le', '-acodec', 'pcm_f32le',
      '-ar', String(sampleRate),
      '-ac', '1',
      'pipe:1',
    ];

    const proc = spawn(bin, args, { windowsHide: true });
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 200)}`));
      }
      const buf = Buffer.concat(chunks);
      // Float32Array shares buffer ma serve allineamento corretto
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      // Copia per evitare problemi di lifetime del Buffer Node
      resolve(new Float32Array(f32));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// detectBpm — analisi music-tempo
// ─────────────────────────────────────────────────────────────────────

async function detectBpm(filePath, { maxSeconds = 120 } = {}) {
  const audio = await decodePcmMono(filePath, { maxSeconds });
  if (!audio || audio.length < 44100 * 5) {
    throw new Error(`audio troppo corto (${audio?.length || 0} samples)`);
  }
  const MusicTempo = getMusicTempo();
  // Range BPM DJ: 70..180 → minBeatInterval=60/180, maxBeatInterval=60/70
  const mt = new MusicTempo(audio, {
    minBeatInterval: 60 / 180,
    maxBeatInterval: 60 / 70,
  });
  const tempo = Number(mt.tempo);
  if (!tempo || !Number.isFinite(tempo)) {
    throw new Error('music-tempo non ha rilevato BPM');
  }
  return Math.round(tempo);
}

// ─────────────────────────────────────────────────────────────────────
// Correzione half/double-time per generi DJ
// (music-tempo a volte ritorna il doppio o metà del BPM reale)
// ─────────────────────────────────────────────────────────────────────

const GENRE_BPM_RANGES = {
  reggaeton:    [85, 108],
  dembow:       [85, 108],
  bachata:      [120, 140],
  afrohouse:    [110, 126],
  afrobeats:    [98, 118],
  techhouse:    [118, 136],
  house:        [118, 132],
  houselatino:  [115, 130],
  deephouse:    [115, 128],
  techno:       [125, 140],
  trance:       [130, 145],
  dnb:          [160, 180],
  dubstep:      [135, 150],
  trap:         [130, 160],
  hiphop:       [80, 105],
  pop:          [95, 130],
};

function correctBpmForGenre(bpm, genreKey) {
  const range = GENRE_BPM_RANGES[String(genreKey || '').toLowerCase()] || null;
  if (!range) return bpm;
  const [min, max] = range;
  if (bpm > max * 1.4) return Math.round(bpm / 2);
  if (bpm < min / 1.4) return Math.round(bpm * 2);
  return bpm;
}

// ─────────────────────────────────────────────────────────────────────
// detectBpmIfMissing — chiamato in pipeline; muta track in-place
// (applica correzione half/double-time se track.detectedGenre è noto)
// ─────────────────────────────────────────────────────────────────────

async function detectBpmIfMissing(track) {
  if (!track || !track.filePath) return track;
  if (track.bpm && Number(track.bpm) > 0) return track; // già presente

  // Persistent cache hit → salta calcolo
  const cached = analysisCache.getCached(track.filePath);
  if (cached && cached.bpm && Number(cached.bpm) > 0) {
    track.bpm = cached.bpm;
    console.log('[CACHE HIT bpm]', track.fileName);
    return track;
  }

  try {
    let bpm = await detectBpm(track.filePath);
    bpm = correctBpmForGenre(bpm, track.detectedGenre);
    if (bpm < 60 || bpm > 200) {
      track.bpmError = `out of range: ${bpm}`;
      return track;
    }
    track.bpm = bpm;
    track.bpmDetected = true; // marker per writeAnalysisTags
    analysisCache.setCached(track.filePath, { bpm });
  } catch (err) {
    track.bpmError = err.message;
  }
  return track;
}

// ─────────────────────────────────────────────────────────────────────
// API spec: detectBpmAll(tracks, onProgress)
// ─────────────────────────────────────────────────────────────────────

async function detectBpmAll(tracks, onProgress) {
  const list = tracks || [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    await detectBpmIfMissing(t);
    if (typeof onProgress === 'function') {
      try { onProgress(i + 1, list.length, t); } catch { /* noop */ }
    }
  }
  return list;
}

module.exports = {
  decodePcmMono,
  detectBpm,
  detectBpmIfMissing,
  detectBpmAll,
  correctBpmForGenre,
  GENRE_BPM_RANGES,
};
