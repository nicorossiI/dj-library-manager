/**
 * src/services/duplicateService.js
 *
 * Trova gruppi di tracce duplicate usando la nuova API DuplicateGroup
 * (con items: DuplicateItem[]).
 *
 * Strategia a 3 fasi:
 *   1) Match esatto su acrId (recognitionConfidence alta)
 *   2) Match acustico: bucket su prefix fingerprint + similarity title+artist
 *   3) Match testuale: chiave normalizzata title+artist identica
 *
 * Esporta: findDuplicates
 * Dipendenze: stringUtils, DuplicateGroup, DuplicateItem, CONFIG
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const {
  normalizeSongTitle, normalizeArtistName, calculateSimilarity,
} = require('../utils/stringUtils');
const { CONFIG } = require('../constants/CONFIG');
const { DuplicateGroup, DuplicateItem } = require('../models/DuplicateGroup');
const { getFpcalcPath } = require('./fingerprintService');

const DEFAULT_THRESHOLD = CONFIG.DUPLICATE_THRESHOLD ?? 0.88;

function fingerprintPrefix(fp, n = 24) {
  if (!fp) return null;
  return String(fp).slice(0, n);
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function textKey(t) {
  const title = normalizeSongTitle(t.localTitle || t.recognizedTitle || t.bestTitle || t.fileName || '');
  const artist = normalizeArtistName(t.localArtist || t.recognizedArtist || t.bestArtist || '');
  if (!title) return '';
  return `${artist}|${title}`;
}

function trackToItem(t, opts = {}) {
  return new DuplicateItem({
    trackId: t.id,
    filePath: t.filePath,
    displayName: t.displayName || `${t.bestArtist || ''} - ${t.bestTitle || ''}`.trim(),
    fileSize: t.fileSize || 0,
    duration: t.duration || 0,
    bitrate: t.bitrate || 0,
    format: t.format || '',
    isMixSegment: !!opts.isMixSegment,
    parentMixPath: opts.parentMixPath || null,
    segmentTimestamp: opts.segmentTimestamp || null,
    segmentIndex: opts.segmentIndex ?? null,
    _meta: {
      title: t.localTitle || t.recognizedTitle,
      artist: t.localArtist || t.recognizedArtist,
      album: t.recognizedAlbum,
      bpm: t.bpm,
      key: t.key,
    },
  });
}

function groupType(items) {
  const anySeg = items.some(i => i.isMixSegment);
  const allSeg = items.every(i => i.isMixSegment);
  if (allSeg) return 'mix_mix';
  if (anySeg) return 'single_mix';
  return 'single_single';
}

function findDuplicates(tracks, { threshold = DEFAULT_THRESHOLD } = {}) {
  const groups = [];
  const consumed = new Set();

  // --- 1) Match ACRCloud id
  const byAcr = groupBy(
    tracks.filter(t => t.isRecognized && t.recognizedTitle),
    t => `${normalizeArtistName(t.recognizedArtist || '')}|${normalizeSongTitle(t.recognizedTitle)}`
  );
  for (const [, list] of byAcr) {
    if (list.length > 1) {
      list.forEach(t => consumed.add(t.id));
      groups.push(new DuplicateGroup({
        type: groupType(list.map(trackToItem)),
        matchType: 'acoustic_exact',
        similarityScore: 1,
        items: list.map(t => trackToItem(t)),
      }));
    }
  }

  // --- 2) Match acustico via prefix fingerprint + similarity
  const remaining = tracks.filter(t => !consumed.has(t.id));
  const byFp = groupBy(remaining, t => fingerprintPrefix(t.fingerprint));
  for (const [, list] of byFp) {
    if (list.length < 2) continue;
    const clusters = clusterBySimilarity(list, threshold);
    for (const c of clusters) {
      if (c.length > 1) {
        c.forEach(t => consumed.add(t.id));
        const items = c.map(t => trackToItem(t));
        const similar = c.every(t => t.fingerprint && c[0].fingerprint
          && t.fingerprint.slice(0, 64) === c[0].fingerprint.slice(0, 64));
        groups.push(new DuplicateGroup({
          type: groupType(items),
          matchType: similar ? 'acoustic_exact' : 'acoustic_similar',
          similarityScore: threshold,
          items,
        }));
      }
    }
  }

  // --- 3) Match testuale puro
  const still = tracks.filter(t => !consumed.has(t.id));
  const byText = groupBy(still, textKey);
  for (const [k, list] of byText) {
    if (!k) continue;
    if (list.length > 1) {
      list.forEach(t => consumed.add(t.id));
      const items = list.map(t => trackToItem(t));
      groups.push(new DuplicateGroup({
        type: groupType(items),
        matchType: 'text_match',
        similarityScore: 0.95,
        items,
      }));
    }
  }

  return groups;
}

function clusterBySimilarity(items, threshold) {
  const clusters = [];
  const used = new Set();
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const cluster = [items[i]];
    used.add(i);
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      const a = items[i], b = items[j];
      const titleSim = calculateSimilarity(
        a.localTitle || a.recognizedTitle || a.fileName || '',
        b.localTitle || b.recognizedTitle || b.fileName || ''
      );
      const artistSim = calculateSimilarity(
        a.localArtist || a.recognizedArtist || '',
        b.localArtist || b.recognizedArtist || ''
      );
      const combined = titleSim * 0.7 + artistSim * 0.3;
      if (combined >= threshold) {
        cluster.push(b);
        used.add(j);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// CROSS-MIX DUPLICATES
// Rileva quando la stessa canzone compare in più mix diversi.
// Ispirato a github.com/kdave/audio-compare (cross-correlazione fp grezzi).
// ---------------------------------------------------------------------------

function getTrackType(t) {
  if (!t) return '';
  return String(t.type || t.fileType || '').toLowerCase() || (t.isMix ? 'mix' : '');
}

function normalizeSegmentKey(artist, title) {
  const a = normalizeArtistName(artist || '');
  const t = normalizeSongTitle(title || '');
  if (!a && !t) return '';
  return `${a}|||${t}`;
}

/**
 * Trova canzoni presenti come segmento in 2+ mix diversi.
 * Verifica opzionale via Chromaprint (fpcalc -raw) estraendo 30s dal punto
 * del segmento e calcolando la similarità di Hamming sui fingerprint grezzi.
 *
 * @param {Track[]} tracks
 * @returns {Promise<Array>} lista { title, artist, appearances[], summary, fingerprintConfirmed }
 */
async function findCrossMixDuplicates(tracks) {
  const results = [];
  const list = Array.isArray(tracks) ? tracks : [];

  const mixes = list.filter(t => getTrackType(t) === 'mix' && Array.isArray(t.mixSegments) && t.mixSegments.length > 0);
  if (mixes.length < 2) return results;

  // Indice: segmentKey → [{mixTrack, segment}]
  const index = new Map();
  for (const mixTrack of mixes) {
    for (const segment of mixTrack.mixSegments) {
      const key = normalizeSegmentKey(segment.artist, segment.title);
      if (!key) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ mixTrack, segment });
    }
  }

  for (const [, occurrences] of index) {
    if (occurrences.length < 2) continue;
    // Deduplica per mix: stesso mix che ha due volte la stessa canzone non conta
    const byMixId = new Map();
    for (const occ of occurrences) {
      const mixId = occ.mixTrack.id || occ.mixTrack.filePath;
      if (!byMixId.has(mixId)) byMixId.set(mixId, occ);
    }
    if (byMixId.size < 2) continue;

    const appearances = Array.from(byMixId.values()).map(o => ({
      mixTrackId: o.mixTrack.id || null,
      mixFileName: o.mixTrack.fileName || (o.mixTrack.filePath ? path.basename(o.mixTrack.filePath) : ''),
      mixFilePath: o.mixTrack.filePath || '',
      segmentIndex: o.segment.index,
      segmentStartSeconds: o.segment.startSeconds || 0,
      segmentTimestamp: o.segment.timestampFormatted
        || secondsToClock(o.segment.startSeconds || 0),
      confidence: o.segment.confidence || 0,
    }));

    const first = occurrences[0].segment;
    results.push({
      type: 'cross_mix_duplicate',
      title: first.title || 'Unknown',
      artist: first.artist || 'Unknown',
      appearances,
      summary: `"${first.artist || '?'} - ${first.title || '?'}" appare in ${appearances.length} mix diversi`,
    });
  }

  // Verifica Chromaprint (best-effort, non blocca)
  for (const dup of results) {
    try {
      const occs = dup.appearances
        .map(a => ({
          mixTrack: { filePath: a.mixFilePath },
          segment: { startSeconds: a.segmentStartSeconds },
        }))
        .filter(o => o.mixTrack.filePath && fs.existsSync(o.mixTrack.filePath));
      dup.fingerprintConfirmed = await verifyWithChromaprint(occs);
    } catch {
      dup.fingerprintConfirmed = null;
    }
  }

  return results;
}

function secondsToClock(total) {
  const t = Math.max(0, Math.round(total || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${s}`;
  return `${m}:${s}`;
}

/**
 * Estrae 30s da ciascuna occorrenza (punto di inizio del segmento),
 * calcola fingerprint grezzi con `fpcalc -raw` e ritorna la similarità
 * bit-a-bit (0-100) tra le prime DUE occorrenze.
 *
 * Tecnica: cross-correlazione Chromaprint ispirata a
 * github.com/kdave/audio-compare.
 */
async function verifyWithChromaprint(appearances) {
  let ffmpegPath = null;
  try { ffmpegPath = require('ffmpeg-static'); } catch { /* noop */ }
  if (!ffmpegPath) return null;

  const fpcalcPath = getFpcalcPath();
  if (!fpcalcPath || !fs.existsSync(fpcalcPath)) return null;
  if (!Array.isArray(appearances) || appearances.length < 2) return null;

  const tmpFiles = [];
  const fingerprints = [];

  try {
    for (let i = 0; i < Math.min(appearances.length, 2); i++) {
      const { mixTrack, segment } = appearances[i];
      const startTime = Math.max(0, Number(segment.startSeconds) || 0);
      const tmpWav = path.join(os.tmpdir(), `djlm_cmp_${Date.now()}_${i}_${process.pid}.wav`);
      tmpFiles.push(tmpWav);

      await new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, [
          '-ss', String(startTime),
          '-t', '30',
          '-i', mixTrack.filePath,
          '-ar', '11025',
          '-ac', '1',
          '-f', 'wav',
          '-y', tmpWav,
        ], { windowsHide: true });
        proc.on('close', c => c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`)));
        proc.on('error', reject);
      });

      const fp = await new Promise((resolve, reject) => {
        const proc = spawn(fpcalcPath, ['-raw', '-length', '30', tmpWav], { windowsHide: true });
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.on('close', () => {
          const m = out.match(/FINGERPRINT=([\-\d,]+)/);
          if (m) resolve(m[1].split(',').map(Number));
          else reject(new Error('no fingerprint'));
        });
        proc.on('error', reject);
      });
      fingerprints.push(fp);
    }

    if (fingerprints.length < 2) return null;
    const fp1 = fingerprints[0];
    const fp2 = fingerprints[1];
    const len = Math.min(fp1.length, fp2.length);
    if (len === 0) return null;

    let matches = 0;
    for (let i = 0; i < len; i++) {
      const xor = (fp1[i] ^ fp2[i]) >>> 0;
      // popcount di 32-bit (bit diversi)
      let v = xor;
      v = v - ((v >>> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      const diffBits = (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
      matches += (32 - diffBits);
    }
    return Math.round((matches / (len * 32)) * 100);
  } finally {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* noop */ }
    }
  }
}

module.exports = {
  findDuplicates,
  findCrossMixDuplicates,
  verifyWithChromaprint,
};
