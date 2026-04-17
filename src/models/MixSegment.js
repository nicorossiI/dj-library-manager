/**
 * src/models/MixSegment.js
 *
 * Segmento riconosciuto dentro un mix/set: intervallo temporale +
 * traccia identificata + metadati (lingua, fingerprint del segmento
 * estratto per cross-duplicate con file singoli).
 *
 * Esporta: MixSegment
 */

'use strict';

class MixSegment {
  constructor(data = {}) {
    this.index = data.index ?? 0;              // posizione 1-based
    this.startSeconds = data.startSeconds ?? 0;
    this.endSeconds = data.endSeconds ?? 0;
    this.title = data.title || '';
    this.artist = data.artist || '';
    this.confidence = data.confidence ?? 0;    // 0-100
    this.language = data.language || '';
    this.fingerprint = data.fingerprint || null;
  }

  get timestampFormatted() {
    const total = Math.max(0, Math.round(this.startSeconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    if (h > 0) {
      const mm = String(m).padStart(2, '0');
      return `${h}:${mm}:${ss}`;
    }
    return `${m}:${ss}`;
  }

  get duration() {
    return Math.max(0, (this.endSeconds || 0) - (this.startSeconds || 0));
  }

  toJSON() {
    return { ...this, timestampFormatted: this.timestampFormatted, duration: this.duration };
  }
}

module.exports = MixSegment;
