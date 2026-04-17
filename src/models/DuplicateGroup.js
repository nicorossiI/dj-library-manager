/**
 * src/models/DuplicateGroup.js
 *
 * Gruppi di tracce duplicate (singolo↔singolo, singolo↔segmento mix, mix↔mix).
 *  - DuplicateGroup: metadata del gruppo (tipo, matchType, similarityScore)
 *  - DuplicateItem:  singolo elemento del gruppo (può essere file o segmento mix)
 *
 * Logica keeper (DuplicateItem.recommended):
 *   1. file singolo > segmento mix
 *   2. a parità:   fileSize maggiore
 *   3. a parità:   più metadati popolati (title+artist+album+bpm+key)
 *
 * Esporta: DuplicateGroup, DuplicateItem
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
  flac: 100, wav: 95, aiff: 95, aif: 95,       // lossless
  aac: 60, m4a: 60, ogg: 55,                    // lossy moderno
  mp3: 50,                                       // lossy classico
};

function formatRank(fmt) {
  return FORMAT_QUALITY_RANK[String(fmt || '').toLowerCase()] ?? 0;
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

    this.isMixSegment = !!data.isMixSegment;
    this.parentMixPath = data.parentMixPath || null;
    this.segmentTimestamp = data.segmentTimestamp || null;
    this.segmentIndex = data.segmentIndex ?? null;

    this.recommended = !!data.recommended;

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
    return { ...this, metadataCompleteness: this.metadataCompleteness };
  }
}

class DuplicateGroup {
  /**
   * @param {object} data
   * @param {'single_single'|'single_mix'|'mix_mix'} [data.type]
   * @param {'acoustic_exact'|'acoustic_similar'|'text_match'} [data.matchType]
   * @param {number} [data.similarityScore] 0..1
   * @param {DuplicateItem[]} [data.items]
   */
  constructor(data = {}) {
    this.id = data.id || uuid();
    this.type = data.type || 'single_single';
    this.matchType = data.matchType || 'acoustic_exact';
    this.similarityScore = data.similarityScore ?? 1;
    this.items = (data.items || []).map(it => (it instanceof DuplicateItem ? it : new DuplicateItem(it)));
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
   *   2. formato lossless (FLAC/WAV/AIFF) > lossy (MP3/AAC/OGG)
   *   3. bitrate più alto (320 > 192 > 128)
   *   4. fileSize maggiore
   *   5. completeness metadati (title+artist+album+bpm+key)
   *   6. path lexicographic (tie-break stabile)
   */
  refreshRecommended() {
    if (!this.items || this.items.length === 0) return;
    this.items.forEach(it => { it.recommended = false; });
    const sorted = [...this.items].sort((a, b) => {
      // 1) non-segment first
      if (a.isMixSegment !== b.isMixSegment) return a.isMixSegment ? 1 : -1;
      // 2) formato (lossless > lossy)
      const fa = formatRank(a.format), fb = formatRank(b.format);
      if (fb !== fa) return fb - fa;
      // 3) bitrate desc (0 = unknown, resta in fondo)
      const ba = Number(a.bitrate) || 0, bb = Number(b.bitrate) || 0;
      if (bb !== ba) return bb - ba;
      // 4) fileSize desc
      if ((b.fileSize || 0) !== (a.fileSize || 0)) return (b.fileSize || 0) - (a.fileSize || 0);
      // 5) completeness desc
      const ca = a.metadataCompleteness;
      const cb = b.metadataCompleteness;
      if (cb !== ca) return cb - ca;
      // 6) tie-break stabile
      return (a.filePath || '').localeCompare(b.filePath || '');
    });
    sorted[0].recommended = true;
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
      items: this.items.map(i => i.toJSON()),
    };
  }
}

module.exports = { DuplicateGroup, DuplicateItem, FORMAT_QUALITY_RANK, formatRank };
module.exports.default = DuplicateGroup;
