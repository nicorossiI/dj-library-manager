/**
 * src/services/musicbrainzService.js
 *
 * Fallback riconoscimento quando ACRCloud non matcha:
 *   1. AcoustID: fingerprint Chromaprint → lookup (score 0-1)
 *   2. MusicBrainz: MBID del recording → tags/genres → chiave genere interna
 *
 * API:
 *   lookupByFingerprint(track)      → { title, artist, score, mbid } | null
 *   getGenreFromMusicBrainz(mbid)   → 'afrohouse'|'techhouse'|... | null
 *
 * Rate-limit: MusicBrainz 1 req/sec (throttle interno). AcoustID gestito dalla lib.
 * Fail-soft: ogni errore → null, pipeline continua.
 *
 * Dipendenze: acoustid, musicbrainz-api, CONFIG, fingerprintService (fpcalc path)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { CONFIG } = require('../constants/CONFIG');
const { getFpcalcPath } = require('./fingerprintService');

// ---------------------------------------------------------------------------
// Lazy singleton MusicBrainzApi (così non init se non serve)
// ---------------------------------------------------------------------------

let _mbApi = null;
function getMbApi() {
  if (_mbApi) return _mbApi;
  const { MusicBrainzApi } = require('musicbrainz-api');
  _mbApi = new MusicBrainzApi({
    appName: 'dj-library-manager',
    appVersion: '1.0.0',
    appContactInfo: 'djlm@local.app',
  });
  return _mbApi;
}

// ---------------------------------------------------------------------------
// fpcalcDirect — spawn manuale di fpcalc bundled per ottenere fingerprint+duration
// Più robusto del pacchetto `acoustid` npm (che non rispetta ACOUSTID_FPCALC env).
// ---------------------------------------------------------------------------

function runFpcalcJson(filePath, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const bin = getFpcalcPath();
    if (!fs.existsSync(bin)) {
      return reject(new Error(`fpcalc non trovato: ${bin}`));
    }
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`file audio non trovato: ${filePath}`));
    }
    const proc = spawn(bin, ['-json', filePath], { windowsHide: true });
    let stdout = '', stderr = '';
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
      finish(reject, new Error(`fpcalc timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    proc.stdout.on('data', c => { stdout += c.toString(); });
    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.on('error', e => { clearTimeout(timer); finish(reject, e); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return finish(reject, new Error(`fpcalc exit ${code}: ${stderr.slice(0, 200)}`));
      try {
        const j = JSON.parse(stdout);
        if (!j.fingerprint || !j.duration) {
          return finish(reject, new Error('fpcalc output incompleto'));
        }
        finish(resolve, { fingerprint: String(j.fingerprint), duration: Math.round(Number(j.duration)) });
      } catch (e) {
        finish(reject, new Error(`fpcalc JSON parse: ${e.message}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// lookupByFingerprint — fpcalc bundled + AcoustID REST API diretta
// Ritorna: { title, artist, score, mbid } | null
// ---------------------------------------------------------------------------

async function lookupByFingerprint(track) {
  if (!track?.filePath) return null;
  if (!fs.existsSync(track.filePath)) return null;

  const timeoutMs = CONFIG.acoustid?.requestTimeoutMs || 10_000;
  const apiKey = CONFIG.acoustid?.key;
  if (!apiKey) return null;

  try {
    // 1. fpcalc → fingerprint + duration (riutilizzo del fingerprint cached se possibile)
    let fingerprint = track.fingerprint;
    let duration = Math.round(Number(track.duration) || 0);
    if (!fingerprint || !duration) {
      const fp = await runFpcalcJson(track.filePath, timeoutMs);
      fingerprint = fp.fingerprint;
      duration = fp.duration;
    }

    // 2. POST AcoustID lookup
    const resp = await axios.post(
      'https://api.acoustid.org/v2/lookup',
      new URLSearchParams({
        client: apiKey,
        meta: 'recordings+releases',
        duration: String(duration),
        fingerprint,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: timeoutMs,
      },
    );

    const data = resp.data || {};
    if (data.status !== 'ok' || !Array.isArray(data.results) || data.results.length === 0) {
      return null;
    }

    const best = data.results[0];
    if (!best || !Array.isArray(best.recordings) || best.recordings.length === 0) return null;

    const rec = best.recordings[0];
    const artist = (rec.artists && rec.artists[0]?.name) || '';
    if (!rec.title || !artist) return null;

    return {
      title: rec.title,
      artist,
      score: Number(best.score) || 0,
      mbid: rec.id || null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rate-limit helper per MusicBrainz (1 req/sec)
// ---------------------------------------------------------------------------

let _lastMbCall = 0;
async function mbThrottle() {
  const gap = 1100; // 1.1s per sicurezza
  const since = Date.now() - _lastMbCall;
  if (since < gap) await new Promise(r => setTimeout(r, gap - since));
  _lastMbCall = Date.now();
}

// ---------------------------------------------------------------------------
// getGenreFromMusicBrainz — mbid → genere interno
// ---------------------------------------------------------------------------

function matchGenreFromTags(allTags) {
  // Ordine: specifico prima di generico
  if (allTags.some(t => /afro.?house|afrohouse/i.test(t))) return 'afrohouse';
  if (allTags.some(t => /tech.?house|techhouse/i.test(t))) return 'techhouse';
  if (allTags.some(t => /deep.?house|deephouse/i.test(t))) return 'deephouse';
  if (allTags.some(t => /dembow/i.test(t))) return 'dembow';
  if (allTags.some(t => /reggaeton|reggaetón/i.test(t))) return 'reggaeton';
  if (allTags.some(t => /bachata/i.test(t))) return 'bachata';
  if (allTags.some(t => /^house$|latin.?house/i.test(t))) return 'house';
  if (allTags.some(t => /^techno$/i.test(t))) return 'techno';
  if (allTags.some(t => /^trance$/i.test(t))) return 'trance';
  if (allTags.some(t => /drum.?and.?bass|dnb|d&b/i.test(t))) return 'dnb';
  if (allTags.some(t => /dubstep/i.test(t))) return 'dubstep';
  if (allTags.some(t => /^trap$/i.test(t))) return 'trap';
  if (allTags.some(t => /hip.?hop|^rap$/i.test(t))) return 'hiphop';
  if (allTags.some(t => /^pop$/i.test(t))) return 'pop';
  return null;
}

async function getGenreFromMusicBrainz(mbid) {
  if (!mbid) return null;
  try {
    await mbThrottle();
    const mbApi = getMbApi();
    const recording = await mbApi.lookup('recording', mbid, ['tags', 'genres', 'artists']);
    const tags = Array.isArray(recording?.tags) ? recording.tags : [];
    const genres = Array.isArray(recording?.genres) ? recording.genres : [];
    const allTags = [...tags, ...genres]
      .map(t => String(t?.name || '').toLowerCase())
      .filter(Boolean);
    if (allTags.length === 0) return null;
    return matchGenreFromTags(allTags);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// getReleaseMbid — dato un recording MBID, risale al release associato
// Serve per Cover Art Archive (richiede release MBID o release-group MBID).
// ---------------------------------------------------------------------------

async function getReleaseMbid(recordingMbid) {
  if (!recordingMbid) return null;
  try {
    await mbThrottle();
    const mbApi = getMbApi();
    const recording = await mbApi.lookup('recording', recordingMbid, ['releases']);
    const releases = Array.isArray(recording?.releases) ? recording.releases : [];
    return releases[0]?.id || null;
  } catch {
    return null;
  }
}

module.exports = {
  lookupByFingerprint,
  getGenreFromMusicBrainz,
  getReleaseMbid,
};
