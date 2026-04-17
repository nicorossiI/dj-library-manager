/**
 * src/services/acrcloudService.js
 *
 * Riconoscimento titolo/artista/album via ACRCloud Identify API.
 *
 * RUOLO in questo progetto:
 *   - Chromaprint (fingerprintService) trova i DOPPIONI offline.
 *   - ACRCloud serve SOLO per popolare nome/artista/album usati per
 *     rinomina + cartella genere + rekordbox.xml.
 *   - Se offline o credenziali mancanti → fallback silenzioso sui metadati
 *     locali (track.localTitle / localArtist). L'app funziona comunque.
 *
 * API spec:
 *   recognizeSingleTrack(track)
 *   recognizeMixFile(track, onProgress)
 *   recognizeAll(tracks, onProgress)
 *   extractAudioSegment(filePath, startSec, durationSec)  → Buffer
 *   buildAcrRequest(audioBuffer, config)                  → FormData
 *
 * Retro-compat:
 *   identifyFile(filePath), identifyMixSegments(filePath, opts),
 *   setCredentials({host,accessKey,accessSecret} | {host,key,secret})
 *
 * Dipendenze: axios, form-data, crypto, fs, os, path, ffmpegService,
 *             fingerprintService, CONFIG, MixSegment, stringUtils
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');

const { CONFIG } = require('../constants/CONFIG');
const MixSegment = require('../models/MixSegment');
const { extractSegment, getDuration } = require('./ffmpegService');
const { fingerprintSegment } = require('./fingerprintService');
const {
  normalizeSongTitle,
  normalizeArtistName,
  isDerivative,
  parseFileNameForMetadata,
} = require('../utils/stringUtils');

// ---------------------------------------------------------------------------
// Credentials (da electron-store runtime, con fallback su CONFIG.acr/.env)
// ---------------------------------------------------------------------------

let _credentials = { host: '', key: '', secret: '' };

/**
 * Accetta entrambi gli shape:
 *   { host, key, secret }            (spec CONFIG.acr)
 *   { host, accessKey, accessSecret }(electron-store legacy)
 */
function setCredentials(creds = {}) {
  _credentials = {
    host:   creds.host   || creds.acrHost   || '',
    key:    creds.key    || creds.accessKey || '',
    secret: creds.secret || creds.accessSecret || '',
  };
}

function getCredentials() {
  const c = _credentials;
  return {
    host:   c.host   || CONFIG.acr.host   || CONFIG.ACRCLOUD_DEFAULT_HOST,
    key:    c.key    || CONFIG.acr.key    || '',
    secret: c.secret || CONFIG.acr.secret || '',
    endpoint: CONFIG.acr.endpoint || CONFIG.ACRCLOUD_ENDPOINT,
  };
}

function hasCredentials() {
  const c = getCredentials();
  return !!(c.key && c.secret && c.host);
}

// ---------------------------------------------------------------------------
// extractAudioSegment → Buffer
// ---------------------------------------------------------------------------

/**
 * Estrae [startSec, startSec+durationSec] in MP3 con ffmpeg-static.
 * Ritorna il Buffer del file temporaneo e poi lo cancella.
 */
async function extractAudioSegment(filePath, startSec, durationSec) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-acr-'));
  const tmpOut = path.join(tmpDir, 'sample.mp3');
  try {
    await extractSegment(filePath, startSec, durationSec, tmpOut);
    return await fsp.readFile(tmpOut);
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// buildAcrRequest
// ---------------------------------------------------------------------------

/**
 * Firma HMAC-SHA1 secondo documentazione ACRCloud:
 *   stringToSign = POST\n/v1/identify\n{access_key}\naudio\n1\n{timestamp}
 * Ritorna un FormData multipart pronto per axios.post.
 *
 * @param {Buffer} audioBuffer
 * @param {{host,key,secret,endpoint}} config
 */
function buildAcrRequest(audioBuffer, config) {
  const httpMethod = 'POST';
  const dataType = 'audio';
  const signatureVersion = '1';
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const stringToSign = [
    httpMethod, config.endpoint, config.key,
    dataType, signatureVersion, timestamp,
  ].join('\n');

  const signature = crypto
    .createHmac('sha1', config.secret)
    .update(stringToSign, 'utf8')
    .digest('base64');

  const form = new FormData();
  form.append('sample', audioBuffer, { filename: 'sample.mp3', contentType: 'audio/mpeg' });
  form.append('sample_bytes', String(audioBuffer.length));
  form.append('access_key', config.key);
  form.append('data_type', dataType);
  form.append('signature_version', signatureVersion);
  form.append('signature', signature);
  form.append('timestamp', timestamp);

  return form;
}

// ---------------------------------------------------------------------------
// Rate limiting + retry
// ---------------------------------------------------------------------------

let _lastRequestAt = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function rateLimitDelay() {
  const delay = CONFIG.recognition.requestDelayMs;
  const elapsed = Date.now() - _lastRequestAt;
  if (elapsed < delay) await sleep(delay - elapsed);
  _lastRequestAt = Date.now();
}

async function postAcrRequest(audioBuffer) {
  const config = getCredentials();
  if (!config.key || !config.secret) {
    throw new Error('ACRCloud: credenziali mancanti (configura da Impostazioni)');
  }

  const maxRetries = CONFIG.recognition.maxRetries;
  const baseBackoff = CONFIG.recognition.retryBackoffMs;
  const timeoutMs = CONFIG.recognition.requestTimeoutMs;
  const url = `https://${config.host}${config.endpoint}`;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const form = buildAcrRequest(audioBuffer, config);
    try {
      await rateLimitDelay();
      const resp = await axios.post(url, form, {
        headers: form.getHeaders(),
        maxContentLength: 50 * 1024 * 1024,
        maxBodyLength: 50 * 1024 * 1024,
        timeout: timeoutMs,
      });
      return resp.data;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const isRateLimit = status === 429;
      const isNetwork = !err.response;
      if ((isRateLimit || isNetwork) && attempt < maxRetries) {
        const backoff = baseBackoff * Math.pow(2, attempt);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('ACRCloud: errore sconosciuto');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function pickFirstMatch(acrResp) {
  const music = acrResp?.metadata?.music?.[0];
  if (!music) return null;
  const rawBpm = music.tempo ?? music.bpm ?? null;
  const bpm = (rawBpm && Number.isFinite(Number(rawBpm)) && Number(rawBpm) > 0)
    ? Math.round(Number(rawBpm))
    : null;
  return {
    acrId: music.acrid || null,
    title: music.title || '',
    artist: (music.artists && music.artists.map(a => a.name).join(', ')) || '',
    album: music.album?.name || '',
    genre: (music.genres && music.genres[0]?.name) || '',
    confidence: Number(music.score) || 0,
    releaseDate: music.release_date || '',
    bpm,
    raw: music,
  };
}

// ---------------------------------------------------------------------------
// recognizeSingleTrack
// ---------------------------------------------------------------------------

async function recognizeSingleTrack(track) {
  if (!track || !track.filePath) return track;

  const fileName = track.fileName || path.basename(track.filePath);
  const derivative = isDerivative(fileName);
  const dur = CONFIG.recognition.singleSampleDuration;
  const defaultStart = derivative
    ? (CONFIG.recognition.singleSampleStartMashup || 60)
    : CONFIG.recognition.singleSampleStart;

  // Se il file è più corto di (start + dur) campiona dal centro.
  let effectiveStart = defaultStart;
  if (track.duration && track.duration < defaultStart + dur) {
    effectiveStart = Math.max(0, Math.floor((track.duration - dur) / 2));
  }

  // FIX 4: manda SEMPRE ad ACRCloud (nome generico non deve bloccare l'API call)
  if (hasCredentials()) {
    try {
      const buf = await extractAudioSegment(track.filePath, effectiveStart, dur);
      const data = await postAcrRequest(buf);
      const match = pickFirstMatch(data);

      if (match && match.confidence >= CONFIG.recognition.minConfidence) {
        track.recognizedTitle = match.title;
        track.recognizedArtist = match.artist;
        track.recognizedAlbum = match.album;
        track.recognitionConfidence = match.confidence;
        if (match.bpm) track.recognizedBpm = match.bpm;
        track.recognitionSource = 'acrcloud';
        track.isRecognized = true;
        track.status = 'recognized';
        return track;
      }
    } catch (e) {
      console.warn('[recognize:acr]', fileName, e.message);
      // fallthrough: prova il fallback parser nome file
    }
  }

  // Fallback 1: AcoustID + MusicBrainz (gratuito, usa fingerprint Chromaprint)
  try {
    const mb = require('./musicbrainzService');
    const r = await mb.lookupByFingerprint(track);
    const minScore = CONFIG.acoustid?.minScore ?? 0.85;
    if (r && r.score > minScore && r.title && r.artist) {
      track.recognizedTitle = r.title;
      track.recognizedArtist = r.artist;
      track.recognitionConfidence = Math.round(r.score * 100);
      track.recognitionSource = 'acoustid_musicbrainz';
      track.mbid = r.mbid;
      track.isRecognized = true;
      track.status = 'recognized';

      // Prova a dedurre il genere via MusicBrainz tags
      if (r.mbid) {
        try {
          const g = await mb.getGenreFromMusicBrainz(r.mbid);
          if (g) track.mbGenre = g;
        } catch { /* noop */ }
      }
      return track;
    }
  } catch (e) {
    console.warn('[recognize:mb]', track?.fileName, e.message);
  }

  // Fallback 2: SHAZAM (gratis, illimitato)
  // Particolarmente efficace su afrohouse edit, techhouse blend e mashup
  // dove ACRCloud fallisce perché riconosce le vocals sulla base originale.
  try {
    const shazamService = require('./shazamService');
    const sr = await shazamService.recognizeSingle(track);
    if (sr && sr.title && sr.artist && sr.confidence >= 70) {
      track.recognizedTitle = sr.title;
      track.recognizedArtist = sr.artist;
      track.recognitionConfidence = sr.confidence;
      track.recognitionSource = 'shazam';
      track.shazamKey = sr.shazamKey;
      track.isRecognized = true;
      track.status = 'recognized';
      // Hint per cover art + classificazione genere
      if (sr.coverArtUrl && !track.coverArtUrl) track.coverArtUrl = sr.coverArtUrl;
      if (sr.genre && !track.shazamGenre) track.shazamGenre = sr.genre;
      return track;
    }
  } catch (e) {
    console.warn('[recognize:shazam]', track?.fileName, e.message);
  }

  // Fallback 3: parser nome file (ultimo tentativo)
  const parsed = parseFileNameForMetadata(fileName);
  if (parsed.artist.length > 2 && parsed.title.length > 2) {
    track.recognizedTitle = parsed.title;
    track.recognizedArtist = parsed.artist;
    track.recognitionConfidence = 0;
    track.recognitionSource = 'filename_parser';
  } else if ((track.localArtist || '').trim() && (track.localTitle || '').trim()) {
    // I tag ID3 locali esistono e verranno usati come display: attribuiamoli
    track.recognitionSource = 'id3_tags';
  } else {
    track.recognitionSource = 'none';
  }
  track.isRecognized = false;
  return track;
}

// ---------------------------------------------------------------------------
// recognizeMixFile (con deduplicazione contigua)
// ---------------------------------------------------------------------------

/**
 * Campiona il mix ogni mixSampleInterval secondi, identifica ogni campione,
 * compatta campioni consecutivi della stessa traccia in un singolo MixSegment,
 * poi calcola il fingerprint acustico di ogni segmento (per cross-duplicate
 * con file singoli).
 */
async function recognizeMixFile(track, onProgress) {
  if (!track || !track.filePath) return track;

  const hasAcr = hasCredentials();
  let shazamService = null;
  try { shazamService = require('./shazamService'); } catch { /* noop */ }

  // Se niente ACR e niente Shazam: non possiamo analizzare
  if (!hasAcr && !shazamService) {
    track.isRecognized = false;
    track.mixSegments = [];
    return track;
  }

  const total = track.duration || await getDuration(track.filePath).catch(() => 0);
  const interval = CONFIG.recognition.mixSampleInterval;  // 55
  const sampleDur = CONFIG.recognition.mixSampleDuration; // 12
  const minConf = CONFIG.recognition.minConfidence;

  // --- Campiona l'intero mix ------------------------------------------
  // Strategia: Shazam PRIMA (gratis/illimitato, robusto su vocals-on-edit).
  // ACRCloud come fallback solo se Shazam fallisce o confidence bassa.
  const rawMatches = []; // [{ t, match }]
  for (let t = 0; t + sampleDur <= total; t += interval) {
    let match = null;

    // 1) Shazam
    if (shazamService) {
      try {
        const sr = await shazamService.recognizeAtOffset(track.filePath, t, sampleDur);
        if (sr && sr.title && sr.artist && sr.confidence >= 70) {
          match = {
            title: sr.title,
            artist: sr.artist,
            confidence: sr.confidence,
            source: 'shazam',
          };
        }
      } catch { /* continua con ACR */ }
    }

    // 2) ACRCloud fallback
    if (!match && hasAcr) {
      try {
        const buf = await extractAudioSegment(track.filePath, t, sampleDur);
        const data = await postAcrRequest(buf);
        const acrMatch = pickFirstMatch(data);
        if (acrMatch && acrMatch.confidence >= minConf) {
          match = { ...acrMatch, source: 'acrcloud' };
        }
      } catch { /* errore singolo campione */ }
    }

    const lastTitle = match?.title || '';
    if (typeof onProgress === 'function') {
      try { onProgress(t, total, lastTitle); } catch { /* noop */ }
    }
    if (match) rawMatches.push({ t, match });
  }

  // --- Deduplicazione contigua ----------------------------------------
  const segments = [];
  let lastKey = null;
  let idx = 1;
  for (const { t, match } of rawMatches) {
    const key = `${normalizeArtistName(match.artist)}|${normalizeSongTitle(match.title)}`;
    if (key === lastKey && segments.length > 0) {
      // Estendi il segmento corrente
      const cur = segments[segments.length - 1];
      cur.endSeconds = t + sampleDur;
      // Tieni la confidence massima rilevata
      cur.confidence = Math.max(cur.confidence, match.confidence);
    } else {
      segments.push(new MixSegment({
        index: idx++,
        startSeconds: t,
        endSeconds: t + sampleDur,
        title: match.title,
        artist: match.artist,
        confidence: match.confidence,
        language: '',
      }));
      lastKey = key;
    }
  }

  // --- Fingerprint per segmento ---------------------------------------
  // Evita segmenti troppo corti: se endSeconds-startSeconds < 10 usa 10s estesi
  for (const seg of segments) {
    const dur = Math.max(10, Math.min(30, seg.endSeconds - seg.startSeconds));
    try {
      seg.fingerprint = await fingerprintSegment(track.filePath, seg.startSeconds, dur);
    } catch {
      seg.fingerprint = null;
    }
  }

  track.mixSegments = segments;
  track.isRecognized = segments.length > 0;
  track.status = segments.length > 0 ? 'recognized' : track.status;

  if (typeof onProgress === 'function') {
    try { onProgress(total, total, ''); } catch { /* noop */ }
  }
  return track;
}

// ---------------------------------------------------------------------------
// recognizeAll
// ---------------------------------------------------------------------------

/**
 * Dispatcher: ogni track viene routato a recognizeSingleTrack o recognizeMixFile
 * in base al flag isMix. Rate-limit interno via postAcrRequest.
 *
 * Tracks già recognized (track.isRecognized === true) vengono skippati per
 * permettere retry incrementali.
 */
async function recognizeAll(tracks, onProgress) {
  const list = tracks || [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t.isRecognized) {
      if (typeof onProgress === 'function') onProgress(i + 1, list.length, t);
      continue;
    }
    try {
      if (t.isMix) {
        await recognizeMixFile(t);
      } else {
        await recognizeSingleTrack(t);
      }
    } catch (err) {
      t.isRecognized = false;
      // log warning nel campo errorMessage ma NON cambiamo status in 'error'
      // (il riconoscimento è opzionale)
      t.errorMessage = (t.errorMessage ? t.errorMessage + ' | ' : '') + `acr: ${err.message}`;
    }
    if (typeof onProgress === 'function') {
      try { onProgress(i + 1, list.length, t); } catch { /* noop */ }
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// Retro-compat API (vecchio nome identifyFile / identifyMixSegments)
// ---------------------------------------------------------------------------

async function identifyFile(filePath) {
  if (!hasCredentials()) throw new Error('ACRCloud credentials mancanti');
  const start = CONFIG.recognition.singleSampleStart;
  const dur = CONFIG.recognition.singleSampleDuration;
  const buf = await extractAudioSegment(filePath, start, dur);
  const data = await postAcrRequest(buf);
  return pickFirstMatch(data);
}

async function identifyMixSegments(filePath, {
  segmentSec = CONFIG.recognition.mixSampleDuration,
  stepSec = CONFIG.recognition.mixSampleInterval,
  maxSegments = 200,
} = {}) {
  if (!hasCredentials()) throw new Error('ACRCloud credentials mancanti');
  const total = await getDuration(filePath).catch(() => 0);
  if (!total) return [];
  const segments = [];
  let idx = 0;
  for (let start = 0; start < total && idx < maxSegments; start += stepSec) {
    const end = Math.min(start + segmentSec, total);
    try {
      const buf = await extractAudioSegment(filePath, start, end - start);
      const data = await postAcrRequest(buf);
      const match = pickFirstMatch(data);
      if (match && match.confidence >= CONFIG.recognition.minConfidence) {
        segments.push(new MixSegment({
          index: idx + 1,
          startSeconds: start,
          endSeconds: end,
          title: match.title,
          artist: match.artist,
          confidence: match.confidence,
        }));
      }
    } catch (e) {
      console.warn('[acr mix segment]', e.message);
    }
    idx++;
  }
  return segments;
}

// ---------------------------------------------------------------------------
// testConnection — invia 5s di silenzio MP3 ad ACRCloud per verificare auth
// ---------------------------------------------------------------------------

/**
 * Genera un buffer MP3 contenente N secondi di silenzio puro via ffmpeg-static.
 * Usato per il test della connessione ACRCloud (no payload reale).
 */
function generateSilenceBuffer(seconds = 5) {
  return new Promise((resolve, reject) => {
    let ffmpegStatic;
    try {
      ffmpegStatic = require('ffmpeg-static');
    } catch (err) {
      return reject(new Error('ffmpeg-static non disponibile: ' + err.message));
    }
    // Path-fix per ASAR packaging
    const ffmpegBin = (typeof ffmpegStatic === 'string' && ffmpegStatic.includes('app.asar'))
      ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
      : ffmpegStatic;
    if (!ffmpegBin) return reject(new Error('ffmpeg binary path non risolto'));

    const args = [
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t', String(seconds),
      '-acodec', 'libmp3lame', '-b:a', '128k',
      '-f', 'mp3', 'pipe:1',
    ];
    const proc = spawn(ffmpegBin, args, { windowsHide: true });
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', c => chunks.push(c));
    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 200)}`));
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) return reject(new Error('ffmpeg ha prodotto buffer vuoto'));
      resolve(buf);
    });
  });
}

/**
 * Test reale della connessione ACRCloud: 5s di silenzio → POST /v1/identify.
 * Risposta tipica: "no result found" (auth ok, ma niente da identificare nel
 * silenzio). Auth errata → 401/403 → success=false.
 *
 * @returns {Promise<{success:boolean, responseTime:number, error:string|null}>}
 */
async function testConnection({ seconds = 5 } = {}) {
  const start = Date.now();
  if (!hasCredentials()) {
    return { success: false, responseTime: 0, error: 'no credentials' };
  }

  // Codici ACRCloud che indicano auth FALLITA (da trattare come errore)
  // Codici ACRCloud che indicano AUTH fallita. 2004 NON è auth-fail
  // (è "can't generate fingerprint" del silenzio → auth OK).
  const AUTH_FAIL_CODES = new Set([3001, 3003, 3014]);

  try {
    const buf = await generateSilenceBuffer(seconds);
    const data = await postAcrRequest(buf);
    console.log('[testConnection] ACR response:', JSON.stringify(data).slice(0, 300));
    const code = data?.status?.code;
    if (code !== undefined && AUTH_FAIL_CODES.has(code)) {
      return {
        success: false,
        responseTime: Date.now() - start,
        error: data?.status?.msg || `auth error (code ${code})`,
      };
    }
    // Qualsiasi altra risposta (code=0 ok, 1001 no result, 2005 can't fingerprint, ecc.)
    // = auth valida, server ci ha processato
    return {
      success: true,
      responseTime: Date.now() - start,
      error: null,
      note: data?.status?.msg || 'ok',
    };
  } catch (err) {
    console.log('[testConnection] ERRORE:', err.message);
    const msg = String(err.message || '').toLowerCase();
    // Solo errori di auth REALI e rete falliscono
    const isAuthFail = /invalid.*(key|signature|access)|unauthor|forbidden|403|401/.test(msg);
    const isNetworkFail = /timeout|etimedout|econn|enotfound|getaddrinfo|eai_again/.test(msg);
    if (isAuthFail) {
      return { success: false, responseTime: Date.now() - start, error: `auth: ${err.message}` };
    }
    if (isNetworkFail) {
      return { success: false, responseTime: Date.now() - start, error: `rete: ${err.message}` };
    }
    // Qualsiasi altro errore (incluso "Can't generate fingerprint") = auth accettata
    return {
      success: true,
      responseTime: Date.now() - start,
      error: null,
      note: err.message,
    };
  }
}

module.exports = {
  // spec
  recognizeSingleTrack,
  recognizeMixFile,
  recognizeAll,
  extractAudioSegment,
  buildAcrRequest,
  testConnection,
  // credentials
  setCredentials,
  hasCredentials,
  // retro-compat
  identifyFile,
  identifyMixSegments,
};
