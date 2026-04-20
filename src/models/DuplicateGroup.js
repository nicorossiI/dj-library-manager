/**
 * src/models/DuplicateGroup.js
 *
 * Gruppi di tracce duplicate (singolo↔singolo, singolo↔segmento mix, mix↔mix).
 *  - DuplicateGroup: metadata del gruppo (tipo, matchType, similarityScore)
 *  - DuplicateItem:  singolo elemento del gruppo (può essere file o segmento mix)
 *
 * Priorità keeper (DuplicateItem.recommended), in ordine decrescente:
 *   1. file singolo > segmento mix
 *   2. Formato (FLAC/WAV/AIFF > AAC/M4A/OGG > MP3 > WMA)
 *   3. Bitrate in bande (320 > 256 > 192 > 128) — evita flip a parità reale
 *   4. Fingerprint confidence (match acustico più affidabile)
 *   5. Completeness metadati (title+artist+album+bpm+key)
 *   6. FileSize maggiore (tiebreaker residuo)
 *   7. Path lex (stabilità)
 *
 * Esporta: DuplicateGroup, DuplicateItem, FORMAT_QUALITY_RANK,
 *          formatRank, bitrateScore, getRecommendedReason
 * Dipendenze: crypto
 */

'use strict';

const crypto = require('crypto');

function uuid() {
  // UUID v4 minimale (no dep)
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// Ranking dei formati audio: lossless > lossy a parità di bitrate.
// Valori più alti = più preferiti.
const FORMAT_QUALITY_RANK = {
  flac: 100,                        // lossless compresso
  wav: 90, aiff: 85, aif: 85,       // lossless PCM
  aac: 45, m4a: 45, ogg: 40,        // lossy moderno
  mp3: 50,                           // lossy classico (preferito su aac/ogg per compat DJ)
  wma: 30,
};

function formatRank(fmt) {
  return FORMAT_QUALITY_RANK[String(fmt || '').toLowerCase()] ?? 0;
}

// Banda il bitrate in classi: 320/256/192/128/<128 → differenze di +-2 kbps
// (es. VBR 318 vs 320) non devono ribaltare la scelta keeper.
function bitrateScore(br) {
  const n = Number(br) || 0;
  if (n >= 300) return 100;  // MP3 320 / lossless
  if (n >= 250) return 80;   // MP3 256
  if (n >= 190) return 60;   // MP3 192
  if (n >= 120) return 40;   // MP3 128
  return 20;
}

class DuplicateItem {
  constructor(data = {}) {
    this.trackId = data.trackId || '';
    this.filePath = data.filePath || '';
    this.displayName = data.displayName || '';
    this.fileSize = data.fileSize || 0;
    this.duration = data.duration || 0;
    this.bitrate = data.bitrate || 0;        // kbps (per ranking qualità)
    this.format = data.format || '';         // "mp3"/"flac"/"wav"/... (per ranking)
    this.fingerprintConfidence = Number(data.fingerprintConfidence) || 0; // 0..1 o 0..100

    this.isMixSegment = !!data.isMixSegment;
    this.parentMixPath = data.parentMixPath || null;
    this.segmentTimestamp = data.segmentTimestamp || null;
    this.segmentIndex = data.segmentIndex ?? null;

    this.recommended = !!data.recommended;
    this.recommendedReason = data.recommendedReason || '';

    // campi extra usati dal calcolo completeness
    this._meta = data._meta || {}; // { title, artist, album, bpm, key }
  }

  /** Numero di metadati "importanti" non vuoti: 0..5 */
  get metadataCompleteness() {
    const m = this._meta || {};
    const keys = ['title', 'artist', 'album', 'bpm', 'key'];
    return keys.reduce((acc, k) => acc + (m[k] ? 1 : 0), 0);
  }

  toJSON() {
    return {
      ...this,
      metadataCompleteness: this.metadataCompleteness,
      recommendedReason: this.recommendedReason,
    };
  }
}

/**
 * Spiega all'utente PERCHÉ questo item è il keeper consigliato.
 * Ritorna stringhe corte tipo "FLAC, qualità migliore" o "MP3 320kbps".
 */
function getRecommendedReason(item) {
  if (!item) return '';
  const ext = String(item.format || (item.filePath || '').split('.').pop() || '').toLowerCase();
  if (['flac', 'wav', 'aiff', 'aif'].includes(ext)) {
    return `${ext.toUpperCase()}, qualità migliore`;
  }
  const br = Number(item.bitrate) || 0;
  if (br >= 300) return `${ext ? ext.toUpperCase() + ' ' : ''}${Math.round(br)}kbps`;
  if (br >= 250) return `${Math.round(br)}kbps, qualità più alta`;
  if ((item.fingerprintConfidence || 0) > 0) return 'match acustico più affidabile';
  return 'qualità migliore disponibile';
}

class DuplicateGroup {
  /**
   * @param {object} data
   * @param {'single_single'|'single_mix'|'mix_mix'} [data.type]
   * @param {'acoustic_exact'|'acoustic_similar'|'text_match'} [data.matchType]
   * @param {number} [data.similarityScore] 0..1
   * @param {DuplicateItem[]} [data.items]
   * @param {boolean} [data.requiresManualReview] — true se il match è sotto la
   *     soglia di auto-delete (text_match o acoustic_similar): il renderer
   *     mostra un badge arancione e la pipeline "Fai Tutto" salta questo gruppo.
   */
  constructor(data = {}) {
    this.id = data.id || uuid();
    this.type = data.type || 'single_single';
    this.matchType = data.matchType || 'acoustic_exact';
    this.similarityScore = data.similarityScore ?? 1;
    this.items = (data.items || []).map(it => (it instanceof DuplicateItem ? it : new DuplicateItem(it)));
    this.requiresManualReview = !!data.requiresManualReview;
    this.refreshRecommended();
  }

  addItem(item) {
    const it = item instanceof DuplicateItem ? item : new DuplicateItem(item);
    this.items.push(it);
    this.refreshRecommended();
    return it;
  }

  /**
   * Ricalcola quale item tenere. Priorità decrescente:
   *   1. file singolo > segmento mix
   *   2. formato (FLAC > WAV > AIFF > MP3 > AAC/M4A > OGG > WMA)
   *   3. bitrate in bande (320 > 256 > 192 > 128)
   *   4. fingerprint confidence (0..1 o 0..100)
   *   5. completeness metadati
   *   6. fileSize come tiebreaker residuo
   *   7. path lexicographic (tie-break stabile)
   */
  refreshRecommended() {
    if (!this.items || this.items.length === 0) return;
    this.items.forEach(it => { it.recommended = false; it.recommendedReason = ''; });
    const sorted = [...this.items].sort((a, b) => {
      // 1) non-segment first
      if (a.isMixSegment !== b.isMixSegment) return a.isMixSegment ? 1 : -1;
      // 2) formato
      const fa = formatRank(a.format), fb = formatRank(b.format);
      if (fb !== fa) return fb - fa;
      // 3) bitrate banded
      const ba = bitrateScore(a.bitrate), bb = bitrateScore(b.bitrate);
      if (bb !== ba) return bb - ba;
      // 4) fingerprint confidence
      const fpa = Number(a.fingerprintConfidence) || 0;
      const fpb = Number(b.fingerprintConfidence) || 0;
      if (fpb !== fpa) return fpb - fpa;
      // 5) completeness desc
      const ca = a.metadataCompleteness;
      const cb = b.metadataCompleteness;
      if (cb !== ca) return cb - ca;
      // 6) fileSize desc (ultimo tiebreaker significativo)
      if ((b.fileSize || 0) !== (a.fileSize || 0)) return (b.fileSize || 0) - (a.fileSize || 0);
      // 7) tie-break stabile
      return (a.filePath || '').localeCompare(b.filePath || '');
    });
    sorted[0].recommended = true;
    sorted[0].recommendedReason = getRecommendedReason(sorted[0]);
  }

  get recommendedItem() {
    return this.items.find(i => i.recommended) || null;
  }

  get discardables() {
    return this.items.filter(i => !i.recommended);
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      matchType: this.matchType,
      similarityScore: this.similarityScore,
      requiresManualReview: this.requiresManualReview,
      items: this.items.map(i => i.toJSON()),
    };
  }
}

module.exports = {
  DuplicateGroup,
  DuplicateItem,
  FORMAT_QUALITY_RANK,
  formatRank,
  bitrateScore,
  getRecommendedReason,
};
module.exports.default = DuplicateGroup;
