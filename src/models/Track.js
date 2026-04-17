/**
 * src/models/Track.js
 *
 * Classe Track: rappresentazione unificata di un file audio.
 * Progettata per essere compatibile con Rekordbox XML export.
 *
 * Campi organizzati in gruppi:
 *  - Identificazione (id, rekordboxTrackId)
 *  - File originale (path, size, format)
 *  - Metadati locali (da tag ID3)
 *  - Fingerprint acustico (Chromaprint)
 *  - Riconoscimento ACRCloud
 *  - Tipo calcolato (single/mix/mashup/instrumental)
 *  - Classificazione (genere + lingua + cartella destinazione)
 *  - Output post-organizzazione (nuovo path + URI Rekordbox)
 *  - Stato workflow
 *
 * Esporta: Track
 * Dipendenze: crypto, stringUtils (pathToRekordboxUri, isMashupOrEdit)
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const { pathToRekordboxUri, isMashupOrEdit } = require('../utils/stringUtils');

class Track {
  constructor(data = {}) {
    // ── Identificazione ────────────────────────────────────────────────
    this.id = data.id || Track.computeId(data.filePath || '');
    this.rekordboxTrackId = data.rekordboxTrackId ?? null; // assegnato in export

    // ── File originale ─────────────────────────────────────────────────
    this.filePath = data.filePath || '';
    this.fileName = data.fileName || (data.filePath ? path.basename(data.filePath) : '');
    this.fileSize = data.fileSize || 0;
    this.format = data.format || Track.detectFormat(this.fileName);

    // ── Metadati locali (tag ID3) ─────────────────────────────────────
    this.localTitle = data.localTitle || '';
    this.localArtist = data.localArtist || '';
    this.duration = data.duration || 0;              // secondi float
    this.bpm = data.bpm ?? null;                      // float 2 dec | null
    this.localGenre = data.localGenre || '';
    this.bitrate = data.bitrate || 0;                 // kbps intero
    this.sampleRate = data.sampleRate || 0;           // Hz

    // ── Fingerprint acustico ───────────────────────────────────────────
    this.fingerprint = data.fingerprint || null;
    this.fingerprintDuration = data.fingerprintDuration || 0;

    // ── Riconoscimento ACRCloud ────────────────────────────────────────
    this.recognizedTitle = data.recognizedTitle || '';
    this.recognizedArtist = data.recognizedArtist || '';
    this.recognizedAlbum = data.recognizedAlbum || '';
    this.recognizedBpm = data.recognizedBpm ?? null;          // BPM da ACRCloud (tempo field)
    this.recognitionConfidence = data.recognitionConfidence || 0; // 0-100
    this.isRecognized = !!data.isRecognized;

    // Sorgente identità (title/artist): 'acrcloud' | 'acoustid_musicbrainz'
    //   | 'id3_tags' | 'filename_parser' | 'none'
    this.recognitionSource = data.recognitionSource || null;

    // Sorgente genere (dal classifier): 'path' | 'filename' | 'artist_filename'
    //   | 'discogs' | 'id3_genre' | 'lastfm' | 'artist_hint' | 'mbgenre'
    //   | 'title_kw' | 'bpm_range' | 'none'
    this.classificationSource = data.classificationSource || null;

    // ── Tipo ───────────────────────────────────────────────────────────
    this.type = data.type || 'single';
    this.isMix = !!data.isMix;
    this.isMashup = data.isMashup ?? isMashupOrEdit(this.localTitle);
    this.mixSegments = data.mixSegments || [];

    // ── Classificazione ────────────────────────────────────────────────
    this.detectedGenre = data.detectedGenre || 'unknown';
    this.vocalsLanguage = data.vocalsLanguage || 'instrumental';
    this.targetFolder = data.targetFolder || '';
    this.rekordboxPlaylistFolder = data.rekordboxPlaylistFolder || '';
    this.rekordboxPlaylistName = data.rekordboxPlaylistName || '';

    // ── Output post-organizzazione ─────────────────────────────────────
    this.newFileName = data.newFileName || '';
    this.newFilePath = data.newFilePath || '';
    this.originalFileName = data.originalFileName || this.fileName;
    this.rekordboxUri = data.rekordboxUri || '';

    // ── Stato workflow ─────────────────────────────────────────────────
    this.status = data.status || 'pending';
    this.isDuplicate = !!data.isDuplicate;
    this.duplicateGroupId = data.duplicateGroupId || null;
    this.errorMessage = data.errorMessage || '';
  }

  // ── Static helpers ──────────────────────────────────────────────────
  static computeId(filePath) {
    return crypto.createHash('sha1').update(String(filePath)).digest('hex');
  }

  static detectFormat(fileName = '') {
    const ext = String(fileName).toLowerCase().split('.').pop();
    if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'aiff', 'aif'].includes(ext)) {
      // normalizza m4a → aac (usati come sinonimi nel catalogo)
      return ext === 'm4a' ? 'aac' : ext;
    }
    return 'unknown';
  }

  // ── Getters ─────────────────────────────────────────────────────────
  get bestTitle() {
    if (this.recognizedTitle) return this.recognizedTitle;
    if (this.localTitle) return this.localTitle;
    const base = this.fileName || '';
    return base.replace(/\.[^.]+$/, '');
  }

  get bestArtist() {
    return this.recognizedArtist || this.localArtist || 'Unknown';
  }

  get displayName() {
    const t = this.recognizedTitle || this.localTitle;
    const a = this.recognizedArtist || this.localArtist;
    if (a && t) return `${a} - ${t}`;
    return this.fileName || this.filePath || 'Unknown';
  }

  get durationSeconds() {
    return Math.round(this.duration || 0);
  }

  get bpmFormatted() {
    const v = this.bpm || 0;
    return Number(v).toFixed(2);
  }

  get durationFormatted() {
    const total = Math.round(this.duration || 0);
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

  get typeLabel() {
    switch (this.type) {
      case 'mix': return 'Mix';
      case 'mashup': return 'Mashup/Edit';
      case 'instrumental': return 'Strumentale';
      case 'single':
      default: return 'Singolo';
    }
  }

  get typeIcon() {
    switch (this.type) {
      case 'mix': return '🎛️';
      case 'mashup': return '🔀';
      case 'instrumental': return '🎹';
      case 'single':
      default: return '🎵';
    }
  }

  // ── Metodo critico per Rekordbox ───────────────────────────────────
  /**
   * Calcola URI Rekordbox-compatible da this.newFilePath (fallback: filePath).
   * Aggiorna this.rekordboxUri e lo ritorna.
   */
  computeRekordboxUri() {
    const src = this.newFilePath || this.filePath;
    this.rekordboxUri = pathToRekordboxUri(src);
    return this.rekordboxUri;
  }

  toJSON() {
    return { ...this };
  }
}

module.exports = Track;
