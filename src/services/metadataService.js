/**
 * src/services/metadataService.js
 *
 * Lettura metadata audio e scansione cartelle.
 *  - readTrack(filePath):    parsa tag via music-metadata → istanza Track
 *                            con campi locali + tipo (single/mix/mashup) calcolato
 *  - scanFolder(path, ...):  walk ricorsivo (estensioni mp3/wav/flac/aac/m4a),
 *                            skip file < 30s e non audio, progress callback.
 *
 * Esporta: readTrack, scanFolder, buildTrackFromFile (alias retro-compat)
 * Dipendenze: music-metadata, fs, path, Track, stringUtils, CONFIG
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const Track = require('../models/Track');
const { isMashupOrEdit } = require('../utils/stringUtils');
const { CONFIG } = require('../constants/CONFIG');

// music-metadata v7 è CJS; v8+ ESM — import lazy compatibile
let _mm = null;
async function getMM() {
  if (_mm) return _mm;
  try {
    _mm = require('music-metadata');
  } catch {
    _mm = await import('music-metadata');
  }
  return _mm;
}

const SUPPORTED_EXT = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a']);

// ---------------------------------------------------------------------------
// readTrack
// ---------------------------------------------------------------------------
/**
 * Legge un singolo file audio, ritorna un'istanza Track con:
 *  - campi locali (localTitle, localArtist, duration, bpm, localGenre, ...)
 *  - isMix  (duration > CONFIG.mix.minDurationMinutes * 60)
 *  - isMashup (isMashupOrEdit(title))
 *  - type (single | mix | mashup | instrumental)
 */
async function readTrack(filePath) {
  const stat = await fsp.stat(filePath);
  const mm = await getMM();
  const parse = mm.parseFile || mm.default?.parseFile;

  let common = {};
  let format = {};
  let native = {};
  try {
    const meta = await parse(filePath, { duration: true });
    common = meta.common || {};
    format = meta.format || {};
    native = meta.native || {};
  } catch (err) {
    // File illeggibile: ritorna un Track stub in errore (il chiamante decide)
    const t = new Track({
      filePath,
      fileName: path.basename(filePath),
      fileSize: stat.size,
      status: 'error',
      errorMessage: `tag read failed: ${err.message}`,
    });
    return t;
  }

  const duration = format.duration || 0;
  const localTitle = common.title || '';
  const localArtist = (common.artists && common.artists.join(', ')) || common.artist || '';
  const localGenre = (common.genre && common.genre[0]) || '';
  // BPM: music-metadata.common.bpm, altrimenti TBPM nativo ID3v2.4/2.3
  const readNativeTbpm = (tagList) => {
    if (!Array.isArray(tagList)) return null;
    const tag = tagList.find(t => t && t.id === 'TBPM');
    if (!tag) return null;
    const n = parseFloat(tag.value);
    return (Number.isFinite(n) && n > 0) ? n : null;
  };
  let bpm = (typeof common.bpm === 'number' && !Number.isNaN(common.bpm) && common.bpm > 0)
    ? common.bpm
    : (readNativeTbpm(native['ID3v2.4']) || readNativeTbpm(native['ID3v2.3']) || null);
  bpm = (bpm && bpm > 0) ? Math.round(bpm * 100) / 100 : null;

  const minMixSec = (CONFIG.mix?.minDurationMinutes || 10) * 60;
  const isMix = duration >= minMixSec;
  const isMashup = isMashupOrEdit(localTitle);

  // Tipo: mix > mashup > (instrumental se marker esplicito nel titolo) > single
  let type = 'single';
  if (isMix) type = 'mix';
  else if (isMashup) type = 'mashup';
  else if (/\binstrumental\b/i.test(localTitle)) type = 'instrumental';

  const track = new Track({
    filePath,
    fileName: path.basename(filePath),
    fileSize: stat.size,
    format: Track.detectFormat(filePath),

    localTitle,
    localArtist,
    localGenre,
    duration,
    bpm,
    bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : 0,
    sampleRate: format.sampleRate || 0,

    isMix,
    isMashup,
    type,
    status: 'pending',
  });

  return track;
}

// ---------------------------------------------------------------------------
// scanFolder
// ---------------------------------------------------------------------------
/**
 * Enumera ricorsivamente i file audio supportati e ritorna array di Track.
 * Saltiamo: file con durata < 30s, file non audio, cartella output già creata.
 *
 * @param {string} folderPath
 * @param {boolean} [recursive=true]
 * @param {(scanned:number,total:number,currentFile:string)=>void} [onProgress]
 */
async function scanFolder(folderPath, recursive = true, onProgress = null) {
  const files = await enumerateAudioFiles(folderPath, recursive);
  const tracks = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (typeof onProgress === 'function') {
      try { onProgress(i, files.length, f); } catch { /* noop */ }
    }
    try {
      const t = await readTrack(f);
      const minDur = CONFIG.minTrackDurationSec || 30;
      if (t.duration > 0 && t.duration < minDur) continue; // skip troppo corti
      tracks.push(t);
    } catch (err) {
      tracks.push(new Track({
        filePath: f,
        fileName: path.basename(f),
        status: 'error',
        errorMessage: err.message,
      }));
    }
  }
  if (typeof onProgress === 'function') {
    try { onProgress(files.length, files.length, ''); } catch { /* noop */ }
  }
  return tracks;
}

async function enumerateAudioFiles(root, recursive) {
  const results = [];
  const maxDepth = CONFIG.MAX_SCAN_DEPTH || 12;
  const outputFolder = CONFIG.OUTPUT_FOLDER_NAME || 'DJ Library Organizzata';

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!recursive) continue;
        if (e.name === outputFolder) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (SUPPORTED_EXT.has(ext)) results.push(full);
      }
    }
  }
  await walk(root, 0);
  return results;
}

// Alias retro-compat (ipcHandlers originale chiamava buildTrackFromFile)
const buildTrackFromFile = readTrack;

// Nota: writeTags era nel vecchio service. Ora lo teniamo per eventuali usi
// futuri (rinomina tag) ma delegato a node-id3 lazy.
async function writeTags(filePath, tags = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.mp3') return { ok: false, reason: `writeTags solo su .mp3 (ricevuto ${ext})` };
  const NodeID3 = require('node-id3');
  const payload = {
    title: tags.title,
    artist: tags.artist,
    album: tags.album,
    genre: tags.genre,
    year: tags.year ? String(tags.year) : undefined,
    bpm: tags.bpm ? String(Math.round(Number(tags.bpm))) : undefined,  // TBPM
    initialKey: tags.key,                                                 // TKEY (Camelot)
  };
  const ok = NodeID3.update(payload, filePath);
  return { ok: !!ok };
}

// Label lingua leggibili — usate per scrivere Comment + Grouping ID3
// così Rekordbox filtra la libreria per lingua senza cartelle separate.
const LANG_LABELS = {
  'es':           'Spagnolo',
  'it':           'Italiano',
  'it_es':        'Italiano-Spagnolo',
  'en':           'Inglese',
  'mixed':        'Misto',
  'instrumental': 'Strumentale',
  // 'unknown' non è in LANG_LABELS di proposito: se la lingua è davvero ignota
  // preferiamo non scrivere nulla piuttosto che inventare un "Misto" spurio.
};

function normalizeLangKey(l) {
  const s = String(l || '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (/^(es|spa|spanish|spagnol\w*)$/.test(s)) return 'es';
  if (/^(it|ita|italian\w*)$/.test(s)) return 'it';
  if (/^(en|eng|english|ingles\w*)$/.test(s)) return 'en';
  if (s === 'it_es' || s === 'ites' || s === 'es_it') return 'it_es';
  if (s === 'instrumental') return 'instrumental';
  if (s === 'mixed') return 'mixed';
  return 'unknown';
}

/**
 * Scrive BPM + key + lingua + tipo nei tag ID3 (TBPM, TKEY, COMM, TIT1 "grouping").
 * Usato dopo l'analisi per persistere i valori — Rekordbox li legge
 * automaticamente e permette filtrare per lingua/tipo senza cartelle.
 */
async function writeAnalysisTags(track) {
  if (!track || !track.filePath) return { ok: false, reason: 'no filePath' };
  const ext = path.extname(track.filePath).toLowerCase();
  if (ext !== '.mp3') return { ok: false, reason: `non-mp3 (${ext})`, skipped: true };

  const update = {};
  if (track.bpm && Number(track.bpm) > 0) {
    update.bpm = String(Math.round(Number(track.bpm)));
  }
  if (track.key) {
    update.initialKey = String(track.key); // Camelot "8B" o standard
  }

  // Lingua + tipo → Comment + Grouping (Rekordbox li mostra come campi filtrabili).
  // Il Comment viene scritto SOLO se è vuoto o se è già un nostro tag precedente,
  // per evitare di cancellare note personali dell'utente.
  //
  // Se la lingua è DAVVERO sconosciuta (nessuna rilevazione, nessun default),
  // NON scriviamo nulla: meglio un comment vuoto che un "Misto" inventato che
  // rimpiazza eventuali note dell'utente fatte in precedenza.
  try {
    const langKey = normalizeLangKey(track.vocalsLanguage || track.detectedLanguage);
    const langLabel = LANG_LABELS[langKey];

    let typeLabel = 'Singolo';
    if (track.isMix || track.type === 'mix') {
      typeLabel = 'Mix';
    } else if (track.isMashup || track.type === 'mashup') {
      const genreKey = String(track.aiGenre || '').toLowerCase().replace(/[\s\-_]+/g, '');
      const { GENRE_LABELS } = require('../constants/FOLDER_STRUCTURE');
      const gLabel = GENRE_LABELS[genreKey];
      typeLabel = gLabel ? `${gLabel} Edit` : 'Mashup';
    }

    // Se non abbiamo info sulla lingua né tipo distintivo, salta: evita di
    // scrivere "Misto | Singolo" che non aggiunge valore e rischia di
    // sovrascrivere note utente.
    const hasRealLangInfo = langKey !== 'unknown' && !!langLabel;
    const hasDistinctiveType = typeLabel !== 'Singolo';

    if (hasRealLangInfo || hasDistinctiveType) {
      const NodeID3 = require('node-id3');
      const existingTags = NodeID3.read(track.filePath) || {};
      const existingComment = existingTags?.comment?.text || '';
      const KNOWN_LABELS = Object.values(LANG_LABELS);
      const isOurTag = existingComment.includes(' | ')
        && KNOWN_LABELS.some(l => existingComment.startsWith(l));

      const text = `${langLabel || 'Misto'} | ${typeLabel}`;
      if (!existingComment || isOurTag) {
        update.comment = { language: 'ita', text };
      }
      if (hasRealLangInfo) {
        // Grouping (TIT1): campo custom dedicato — scriviamo solo se abbiamo
        // info reali sulla lingua.
        update.grouping = langLabel;
      }
    }
  } catch { /* noop */ }

  if (Object.keys(update).length === 0) return { ok: false, reason: 'nothing to write' };

  try {
    const NodeID3 = require('node-id3');
    const okRes = NodeID3.update(update, track.filePath);
    return { ok: !!okRes };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  readTrack,
  scanFolder,
  writeTags,
  writeAnalysisTags,
  // retro-compat
  buildTrackFromFile,
  // alias retro-compat (vecchio nome readTags -> readTrack non era compatibile, lasciamo stub)
  readTags: async (fp) => {
    const t = await readTrack(fp);
    return {
      title: t.localTitle,
      artist: t.localArtist,
      album: '',
      genre: t.localGenre,
      bpm: t.bpm,
      duration: t.duration,
      bitrate: t.bitrate,
      sampleRate: t.sampleRate,
    };
  },
};
