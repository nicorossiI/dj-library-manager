/**
 * src/services/duplicateService.js
 *
 * Trova gruppi di tracce duplicate con policy di sicurezza sul matching:
 *
 *   1) Match esatto su ACRCloud ID (normalized artist+title, score 1.0)
 *   2) Match acustico MULTI-PREFIX: bucket su prefisso fingerprint (16/24/32
 *      char) + similarity title+artist ≥ CONFIG.duplicates.acousticMatchScore
 *   3) Match testuale via fuse.js con soglia configurabile
 *
 * FLAG `requiresManualReview`: i gruppi non confermati acusticamente NON
 * vengono mai auto-eliminati dal pipeline "Fai Tutto" — il renderer li
 * mostra nel tab Doppioni per revisione umana.
 *
 * Esporta: findDuplicates
 * Dipendenze: stringUtils, fuse.js, DuplicateGroup, DuplicateItem, CONFIG
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Fuse = require('fuse.js');
const { runProc } = require('../utils/runProc');

const {
  normalizeSongTitle, normalizeArtistName, calculateSimilarity,
} = require('../utils/stringUtils');
const { CONFIG } = require('../constants/CONFIG');
const { DuplicateGroup, DuplicateItem } = require('../models/DuplicateGroup');
const { getFpcalcPath } = require('./fingerprintService');

const DUP_CFG = CONFIG.duplicates || {};
const DEFAULT_THRESHOLD = DUP_CFG.acousticMatchScore ?? CONFIG.DUPLICATE_THRESHOLD ?? 0.88;
const FP_PREFIXES = DUP_CFG.fingerprintPrefixes || [16, 24, 32];
const FUSE_THRESHOLD = DUP_CFG.fuseTextThreshold ?? 0.2;
const TEXT_MATCH_ENABLED = DUP_CFG.textMatchEnabled ?? true;

/**
 * Estrae N prefissi diversi da un fingerprint. Un file re-encoded ha i
 * primi 16 char spesso identici ma i primi 32 leggermente diversi: matching
 * multi-prefix cattura entrambi i casi senza O(n²) completo.
 */
function fingerprintBuckets(fp) {
  if (!fp || String(fp).length < 16) return [];
  const s = String(fp);
  return FP_PREFIXES
    .filter(n => s.length >= n)
    .map(n => s.slice(0, n));
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

/**
 * Mappa la recognitionConfidence ACRCloud (0-100) in 0..1.
 * Se manca ACR ma c'è un fingerprint Chromaprint: 0.8 (confidence di default
 * per fingerprint presente ma non cross-referenced).
 */
function deriveFingerprintConfidence(t) {
  const acrRaw = Number(t?.recognitionConfidence);
  if (Number.isFinite(acrRaw) && acrRaw > 0) {
    return acrRaw > 1 ? acrRaw / 100 : acrRaw;
  }
  const acrScore = Number(t?.acr?.score);
  if (Number.isFinite(acrScore) && acrScore > 0) {
    return acrScore > 1 ? acrScore / 100 : acrScore;
  }
  if (t?.fingerprint) return 0.8;
  return 0;
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
    fingerprintConfidence: deriveFingerprintConfidence(t),
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
  const list = Array.isArray(tracks) ? tracks : [];

  // ── 1) Match ACRCloud esatto ─────────────────────────────────────
  // Due tracce che hanno lo STESSO riconoscimento ACRCloud sono duplicati certi.
  const byAcr = groupBy(
    list.filter(t => t.isRecognized && t.recognizedTitle),
    t => `${normalizeArtistName(t.recognizedArtist || '')}|${normalizeSongTitle(t.recognizedTitle)}`
  );
  for (const [, cluster] of byAcr) {
    if (cluster.length > 1) {
      cluster.forEach(t => consumed.add(t.id));
      const items = cluster.map(t => trackToItem(t));
      groups.push(new DuplicateGroup({
        type: groupType(items),
        matchType: 'acoustic_exact',
        similarityScore: 1,
        items,
        requiresManualReview: false,
      }));
    }
  }

  // ── 2) Match acustico MULTI-PREFIX ──────────────────────────────
  // Bucket su 3 prefissi (16/24/32 char). Un file e la sua ri-encoded spesso
  // condividono i primi 16 char anche se i primi 32 divergono leggermente.
  // Deduplica i confronti via `comparedPairs` per non fare lo stesso match
  // una volta per bucket.
  const remaining = list.filter(t => !consumed.has(t.id) && t.fingerprint);
  const byFp = new Map();
  for (const t of remaining) {
    for (const bucket of fingerprintBuckets(t.fingerprint)) {
      if (!byFp.has(bucket)) byFp.set(bucket, []);
      byFp.get(bucket).push(t);
    }
  }

  const comparedPairs = new Set();
  const accepted = new Map(); // trackId → cluster array (union-find lite)

  function pairKey(a, b) {
    return a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
  }

  for (const [, bucket] of byFp) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        if (consumed.has(a.id) || consumed.has(b.id)) continue;
        const pk = pairKey(a, b);
        if (comparedPairs.has(pk)) continue;
        comparedPairs.add(pk);

        const titleSim = calculateSimilarity(
          a.localTitle || a.recognizedTitle || a.fileName || '',
          b.localTitle || b.recognizedTitle || b.fileName || ''
        );
        const artistSim = calculateSimilarity(
          a.localArtist || a.recognizedArtist || '',
          b.localArtist || b.recognizedArtist || ''
        );
        const combined = titleSim * 0.7 + artistSim * 0.3;
        if (combined < threshold) continue;

        // Union-find: se uno dei due è già in un cluster, fondi.
        const clA = accepted.get(a.id);
        const clB = accepted.get(b.id);
        if (clA && clB) {
          if (clA !== clB) {
            for (const x of clB) {
              clA.push(x);
              accepted.set(x.id, clA);
            }
          }
        } else if (clA) {
          clA.push(b);
          accepted.set(b.id, clA);
        } else if (clB) {
          clB.push(a);
          accepted.set(a.id, clB);
        } else {
          const cl = [a, b];
          accepted.set(a.id, cl);
          accepted.set(b.id, cl);
        }
      }
    }
  }

  // Serializza i cluster acustici (ogni cluster è shared via reference)
  const emitted = new Set();
  for (const cluster of accepted.values()) {
    const uniqueByRef = cluster;
    if (emitted.has(uniqueByRef)) continue;
    emitted.add(uniqueByRef);
    if (uniqueByRef.length < 2) continue;
    uniqueByRef.forEach(t => consumed.add(t.id));
    const items = uniqueByRef.map(t => trackToItem(t));
    // Fingerprint "exact" se i primi 64 char coincidono su TUTTI
    const ref = uniqueByRef[0].fingerprint.slice(0, 64);
    const allSame = uniqueByRef.every(t => t.fingerprint.slice(0, 64) === ref);
    groups.push(new DuplicateGroup({
      type: groupType(items),
      matchType: allSame ? 'acoustic_exact' : 'acoustic_similar',
      similarityScore: allSame ? 1 : threshold,
      items,
      // Exact fingerprint = safe; similar = manual review richiesto
      requiresManualReview: !allSame,
    }));
  }

  // ── 3) Match testuale via fuse.js ────────────────────────────────
  if (TEXT_MATCH_ENABLED) {
    const still = list.filter(t => !consumed.has(t.id));
    if (still.length >= 2) {
      const docs = still.map(t => ({
        track: t,
        id: t.id,
        normalizedTitle: normalizeSongTitle(t.localTitle || t.recognizedTitle || t.fileName || ''),
        normalizedArtist: normalizeArtistName(t.localArtist || t.recognizedArtist || ''),
        fingerprint: t.fingerprint || '',
      }));
      // Fuse.js non gestisce bene query multi-campo con stringa composta
      // ("artist + title" come unica query). Facciamo due index separati e
      // intersechiamo: un peer è duplicato se matcha sia sul titolo sia
      // sull'artista (oppure è un match perfetto su uno solo se l'altro è vuoto).
      const titleFuse = new Fuse(docs, {
        includeScore: true,
        threshold: FUSE_THRESHOLD,
        keys: ['normalizedTitle'],
        ignoreLocation: true,
      });
      const artistFuse = new Fuse(docs, {
        includeScore: true,
        threshold: FUSE_THRESHOLD,
        keys: ['normalizedArtist'],
        ignoreLocation: true,
      });

      const textClusters = new Map();
      for (const doc of docs) {
        if (consumed.has(doc.id)) continue;
        if (!doc.normalizedTitle) continue;
        const titleHits = new Map(
          titleFuse.search(doc.normalizedTitle).map(r => [r.item.id, r.score])
        );
        const peers = [];
        if (doc.normalizedArtist) {
          const artistHits = new Map(
            artistFuse.search(doc.normalizedArtist).map(r => [r.item.id, r.score])
          );
          for (const [id, titleScore] of titleHits) {
            if (id === doc.id) continue;
            if (consumed.has(id)) continue;
            if (!artistHits.has(id)) continue;
            peers.push({ id, score: Math.max(titleScore, artistHits.get(id) || 0) });
          }
        } else {
          // Nessun artista: solo title match (più rischioso — il flag review
          // garantisce comunque la conferma umana).
          for (const [id, score] of titleHits) {
            if (id === doc.id) continue;
            if (consumed.has(id)) continue;
            peers.push({ id, score });
          }
        }
        if (peers.length === 0) continue;

        const peerDocs = peers
          .map(p => docs.find(d => d.id === p.id))
          .filter(Boolean);
        const clusterId = [doc.id, ...peerDocs.map(p => p.id)].sort()[0];
        if (!textClusters.has(clusterId)) textClusters.set(clusterId, new Set());
        const set = textClusters.get(clusterId);
        set.add(doc);
        for (const p of peerDocs) set.add(p);
      }

      for (const set of textClusters.values()) {
        const arr = [...set];
        if (arr.length < 2) continue;
        arr.forEach(d => consumed.add(d.id));
        const items = arr.map(d => trackToItem(d.track));
        // Safeguard: se TUTTE le tracce hanno fingerprint e i primi 32 char
        // coincidono, promuovi a acoustic_similar (acusticamente confermato).
        // Altrimenti: text_match puro → requiresManualReview.
        const allFp = arr.every(d => d.fingerprint && d.fingerprint.length >= 32);
        const prefixMatch = allFp
          && arr.every(d => d.fingerprint.slice(0, 32) === arr[0].fingerprint.slice(0, 32));
        groups.push(new DuplicateGroup({
          type: groupType(items),
          matchType: prefixMatch ? 'acoustic_similar' : 'text_match',
          similarityScore: prefixMatch ? 0.92 : 0.80,
          items,
          requiresManualReview: true,
        }));
      }
    }
  }

  return groups;
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

      // Estrai segmento 30s come WAV mono 11025Hz (sufficiente per Chromaprint).
      // tmpWav verrà cancellato dal `finally` esterno, NON qui: fpcalc deve
      // poterlo leggere subito dopo.
      await runProc(ffmpegPath, [
        '-ss', String(startTime),
        '-t', '30',
        '-i', mixTrack.filePath,
        '-ar', '11025',
        '-ac', '1',
        '-f', 'wav',
        '-y', tmpWav,
      ], { timeout: 45_000 });

      const { stdout: fpOut } = await runProc(
        fpcalcPath, ['-raw', '-length', '30', tmpWav],
        { timeout: 30_000 },
      );
      const m = fpOut.match(/FINGERPRINT=([\-\d,]+)/);
      if (!m) throw new Error('no fingerprint');
      fingerprints.push(m[1].split(',').map(Number));
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
