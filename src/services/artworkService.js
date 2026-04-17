/**
 * src/services/artworkService.js
 *
 * Fetch automatico di cover art da Cover Art Archive (MusicBrainz CDN)
 * quando il track ha un MBID (da AcoustID fallback) e il file ID3 è privo
 * di immagine. Scrive direttamente nei tag ID3 APIC (solo MP3).
 *
 * API:
 *   fetchCoverArt(track)                     → boolean (true se scritta)
 *   fetchCoverArtAll(tracks, onProgress)     → {added: N}
 *
 * Fail-soft: ogni errore (404 CAA, file non-MP3, timeout) → skip silenzioso.
 *
 * Dipendenze: axios, music-metadata, node-id3, musicbrainzService
 */

'use strict';

const axios = require('axios');
const path = require('path');

const CAA_BASE = 'https://coverartarchive.org';
const TIMEOUT_MS = 7_000;
const SIZE = 500; // pixel (CAA supporta 250, 500, 1200 o originale)

// music-metadata lazy (stesso pattern di metadataService)
let _mm = null;
async function getMM() {
  if (_mm) return _mm;
  try { _mm = require('music-metadata'); }
  catch { _mm = await import('music-metadata'); }
  return _mm;
}

async function hasEmbeddedArtwork(filePath) {
  try {
    const mm = await getMM();
    const parse = mm.parseFile || mm.default?.parseFile;
    const meta = await parse(filePath);
    const pictures = meta?.common?.picture || [];
    return pictures.length > 0;
  } catch {
    return false; // se non riesco a leggere, provo comunque a scrivere
  }
}

async function fetchArtworkBuffer(mbid, kind = 'release') {
  // kind: 'release' | 'release-group'
  const url = `${CAA_BASE}/${kind}/${mbid}/front-${SIZE}`;
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: TIMEOUT_MS,
      validateStatus: s => s >= 200 && s < 300,
    });
    return Buffer.from(r.data);
  } catch {
    return null;
  }
}

/**
 * Scrive cover art nel tag ID3 del file (solo MP3).
 * Ritorna true se ha scritto qualcosa, false altrimenti.
 */
async function fetchCoverArt(track) {
  if (!track?.filePath) return false;
  if (!track.mbid) return false;               // serve un MBID
  const ext = path.extname(track.filePath).toLowerCase();
  if (ext !== '.mp3') return false;            // node-id3 supporta solo MP3

  // Skip se il file ha già una picture
  if (await hasEmbeddedArtwork(track.filePath)) return false;

  // AcoustID ritorna un recording MBID. Risalgo al release MBID per CAA.
  const mb = require('./musicbrainzService');
  let buf = null;

  // Tentativo 1: se recording ha un release associato, usa quello
  try {
    const releaseMbid = await mb.getReleaseMbid(track.mbid);
    if (releaseMbid) {
      buf = await fetchArtworkBuffer(releaseMbid, 'release');
    }
  } catch { /* noop */ }

  // Tentativo 2 (fallback): CAA con il recording MBID direttamente (raro ma supportato)
  if (!buf) {
    buf = await fetchArtworkBuffer(track.mbid, 'recording');
  }

  if (!buf || buf.length < 500) return false; // CAA a volte ritorna HTML 404

  try {
    const NodeID3 = require('node-id3');
    const ok = NodeID3.update({
      image: {
        mime: 'image/jpeg',
        type: { id: 3, name: 'front cover' },
        description: '',
        imageBuffer: buf,
      },
    }, track.filePath);
    if (ok) {
      track.artworkFetched = true;
      return true;
    }
  } catch { /* noop */ }
  return false;
}

async function fetchCoverArtAll(tracks, onProgress) {
  const list = tracks || [];
  let added = 0;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    try {
      const ok = await fetchCoverArt(t);
      if (ok) added++;
    } catch { /* noop */ }
    if (typeof onProgress === 'function') {
      try { onProgress(i + 1, list.length, t); } catch { /* noop */ }
    }
  }
  return { added };
}

module.exports = {
  fetchCoverArt,
  fetchCoverArtAll,
};
