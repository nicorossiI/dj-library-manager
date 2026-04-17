/**
 * src/constants/CONFIG.js
 *
 * Configurazione globale dell'app. Sezioni principali:
 *   - acr:           credenziali ACRCloud (caricate da process.env / .env)
 *   - recognition:   parametri campionamento + rate-limit + retry ACRCloud
 *   - fingerprint:   lunghezza fpcalc + soglie similarità Chromaprint
 *   - mix:           soglia durata per mix e parametri segmentazione
 *
 * I valori `acr` e `.env` sono DEFAULT di sviluppo. In produzione l'utente
 * inserisce le chiavi da Settings → salvate in electron-store e iniettate
 * a runtime via acrcloudService.setCredentials().
 *
 * Esporta: CONFIG (object congelato)
 */

'use strict';

const CONFIG = Object.freeze({
  APP_NAME: 'DJ Library Manager',

  AUDIO_EXTENSIONS: ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.aiff', '.aif', '.wma'],

  // ── ACRCloud (credenziali + endpoint) ─────────────────────────────────
  acr: Object.freeze({
    host: process.env.ACR_HOST || process.env.ACRCLOUD_HOST || '',
    key: process.env.ACR_KEY || process.env.ACRCLOUD_ACCESS_KEY || '',
    secret: process.env.ACR_SECRET || process.env.ACRCLOUD_ACCESS_SECRET || '',
    endpoint: '/v1/identify',
  }),

  // ── AcoustID (fallback quando ACRCloud non riconosce) ─────────────────
  // La chiave demo qui sotto è pubblica e ha rate-limit aggressivo. Per
  // uso intensivo registrarsi su https://acoustid.org/login e metterla in .env
  acoustid: Object.freeze({
    key: process.env.ACOUSTID_KEY || 'HJEAfGFEke',
    minScore: 0.85,        // soglia confidence per accettare il match
    requestTimeoutMs: 10_000,
  }),

  // ── Discogs (enrichment genere "DJ-preciso" via styles) ───────────────
  // Token personale: https://www.discogs.com/settings/developers
  // Rate-limit: 60 req/min con token, 25 req/min senza.
  discogs: Object.freeze({
    token: process.env.DISCOGS_TOKEN || '',
    minScore: 70,             // score >=70 per accettare il primo risultato
    requestDelayMs: 1100,     // 60 req/min = 1 req/s (+buffer)
    requestTimeoutMs: 8_000,
  }),

  // ── Last.fm (top-tags artista per genere community) ───────────────────
  // API key: gratuita da https://www.last.fm/api/account/create
  lastfm: Object.freeze({
    key: process.env.LASTFM_KEY || '',
    minCount: 50,             // soglia count nei top-tags
    requestDelayMs: 260,      // 5 req/s = 200ms (+buffer)
    requestTimeoutMs: 6_000,
  }),

  // ── Riconoscimento (single + mix + rate-limit + retry) ────────────────
  recognition: Object.freeze({
    singleSampleStart: 30,       // salta intro silenziose
    singleSampleStartMashup: 60, // mashup/edit: al 30 c'è spesso base di un'altra canzone
    singleSampleDuration: 15,    // 15s = sufficiente per il match
    mixSampleInterval: 55,       // ogni 55s un campione
    mixSampleDuration: 12,
    minConfidence: 80,           // 0-100 — score minimo per validare un match ACRCloud
    requestDelayMs: 1200,        // delay tra chiamate API (rate-limit)
    maxRetries: 3,
    retryBackoffMs: 2000,        // base backoff esponenziale (ms)
    requestTimeoutMs: 10_000,    // timeout singola request
  }),

  // ── Concorrenza pool di analisi (p-queue condivisa) ──────────────────
  // Un solo worker pool per:
  //   - pipeline analysis:start / library:analyzeFull
  //   - watcher (add event) — previene rate-limit cascata su bulk-add
  // Default 3 è un buon bilanciamento. Preset Fast/Precise sovrascrivono.
  analysis: Object.freeze({
    defaultConcurrency: 3,
    min: 1,
    max: 8,
    presets: Object.freeze({
      fast:    Object.freeze({ concurrency: 5, acrTimeoutMs:  8_000, label: 'Veloce' }),
      normal:  Object.freeze({ concurrency: 3, acrTimeoutMs: 12_000, label: 'Bilanciato' }),
      precise: Object.freeze({ concurrency: 1, acrTimeoutMs: 20_000, label: 'Preciso' }),
    }),
  }),

  // ── Fingerprint Chromaprint ────────────────────────────────────────────
  fingerprint: Object.freeze({
    fpcalcLength: 120,           // secondi analizzati da fpcalc
    exactThreshold: 0.90,        // > 90% = doppione esatto
    similarThreshold: 0.70,      // 70-90% = versione simile
  }),

  // ── Mix/Set ───────────────────────────────────────────────────────────
  mix: Object.freeze({
    minDurationMinutes: 8,       // >= 8 min → considerato "mix"
    segmentSeconds: 30,          // durata segmento ACRCloud (legacy)
    stepSeconds: 60,             // distanza tra campioni (legacy)
    fingerprintSeconds: 120,     // durata max audio usato per fpcalc su mix
  }),

  // ── Scan / filesystem ─────────────────────────────────────────────────
  minTrackDurationSec: 30,
  MAX_SCAN_DEPTH: 12,
  SKIP_HIDDEN_FILES: true,

  // ── Duplicati (matching testuale Levenshtein) ─────────────────────────
  DUPLICATE_THRESHOLD: 0.88,

  // ── Rename templates ──────────────────────────────────────────────────
  RENAME_FORMAT: '{artist} - {title} [{key}][{bpm}]',
  RENAME_FORMAT_MASHUP: '{artists} - {titles} (Mashup) [{bpm}]',
  RENAME_FORMAT_MIX: '{djName} - {mixName} (Mix)',

  // ── Output ────────────────────────────────────────────────────────────
  OUTPUT_FOLDER_NAME: 'DJ Library Organizzata',
  REKORDBOX_XML_NAME: 'rekordbox.xml',

  // ── Legacy (retro-compat con service esistenti) ───────────────────────
  ACRCLOUD_ENDPOINT: '/v1/identify',
  ACRCLOUD_DEFAULT_HOST: 'identify-eu-west-1.acrcloud.com',
  ACRCLOUD_RATE_LIMIT_PER_SEC: 3,
  MIX_SEGMENT_SEC: 30,
  MIX_STEP_SEC: 60,
  MIX_DURATION_THRESHOLD_SEC: 600,
});

module.exports = { CONFIG };
