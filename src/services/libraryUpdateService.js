/**
 * src/services/libraryUpdateService.js
 *
 * Modalità "aggiungi a libreria esistente":
 *   - loadExistingLibrary(root)              → carica .djlm_cache.json esistente
 *   - checkAgainstExisting(newTracks, cache) → classifica i nuovi in duplicati/unici
 *   - updateRekordboxXml(xmlPath, newTracks) → aggiunge TRACK entries al XML senza rigenerare
 *
 * I duplicati non vengono copiati nella libreria. Solo i `newTracks` rimasti
 * (non duplicati) finiscono nell'organizer + rekordbox.xml.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

const CACHE_FILENAME = '.djlm_cache.json';
const DUP_THRESHOLD = 0.90;

// ---------------------------------------------------------------------------
// loadExistingLibrary
// ---------------------------------------------------------------------------

async function loadExistingLibrary(existingRoot) {
  if (!existingRoot) throw new Error('existingRoot mancante');
  const cachePath = path.join(existingRoot, CACHE_FILENAME);
  if (!fs.existsSync(cachePath)) {
    throw new Error(
      `Cache non trovata in "${existingRoot}". ` +
      `La cartella deve essere stata analizzata almeno una volta.`
    );
  }
  const raw = fs.readFileSync(cachePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.entries) throw new Error('Formato cache non valido (manca "entries")');
  return { ...parsed, root: existingRoot };
}

// ---------------------------------------------------------------------------
// checkAgainstExisting
// ---------------------------------------------------------------------------

/**
 * @param {Track[]} newTracks — tracce appena scansionate (con fingerprint)
 * @param {object}  existingCache — oggetto ritornato da loadExistingLibrary
 * @returns {{ duplicates: Array, newTracks: Track[] }}
 */
async function checkAgainstExisting(newTracks, existingCache) {
  const { compareFingerprints } = require('./fingerprintService');
  const duplicates = [];
  const unique = [];
  const root = existingCache?.root || '';
  const entries = Object.entries(existingCache?.entries || {});

  for (const track of newTracks || []) {
    if (!track?.fingerprint) {
      unique.push(track);
      continue;
    }

    let bestMatch = null;
    for (const [existPath, existData] of entries) {
      if (!existData?.fingerprint) continue;
      const sim = compareFingerprints(track.fingerprint, existData.fingerprint);
      if (sim > DUP_THRESHOLD && (!bestMatch || sim > bestMatch.similarity)) {
        const relPath = root ? path.relative(root, existPath) : existPath;
        bestMatch = {
          existingPath: existPath,
          existingRelPath: relPath,
          existingFolder: path.dirname(relPath) || '',
          existingFileName: path.basename(existPath),
          similarity: sim,
        };
      }
    }

    if (bestMatch) {
      duplicates.push({ newTrack: track, ...bestMatch });
    } else {
      unique.push(track);
    }
  }

  return { duplicates, newTracks: unique };
}

// ---------------------------------------------------------------------------
// parseRekordboxXml / serializeRekordboxXml (xml2js)
// ---------------------------------------------------------------------------

async function parseRekordboxXml(xmlPath) {
  const content = fs.readFileSync(xmlPath, 'utf8');
  // Rimuovi BOM UTF-8 se presente (electron-updater lo richiede, xml2js inciampa)
  const clean = content.replace(/^\uFEFF/, '');
  return xml2js.parseStringPromise(clean, {
    explicitArray: true,   // NODE e TRACK sono sempre array (più prevedibile)
    preserveChildrenOrder: true,
    trim: false,
    attrkey: '$',
    charkey: '_',
  });
}

function buildRekordboxXmlString(docObj) {
  const builder = new xml2js.Builder({
    xmldec: { version: '1.0', encoding: 'UTF-8' },
    renderOpts: { pretty: true, indent: '  ', newline: '\n' },
    attrkey: '$',
    charkey: '_',
  });
  // BOM UTF-8: Rekordbox lo richiede per caratteri non-ASCII nelle playlist
  return '\uFEFF' + builder.buildObject(docObj);
}

// Cerca ricorsivamente il nodo playlist (Type="1") con Name=playlistName
// dentro il sotto-albero PLAYLISTS. Ritorna il riferimento oggetto oppure null.
function findPlaylistNode(rootNode, playlistName) {
  if (!rootNode) return null;
  const children = Array.isArray(rootNode.NODE) ? rootNode.NODE : [];
  for (const child of children) {
    const attrs = child?.$ || {};
    if (attrs.Type === '1' && attrs.Name === playlistName) return child;
    const deep = findPlaylistNode(child, playlistName);
    if (deep) return deep;
  }
  return null;
}

// ---------------------------------------------------------------------------
// updateRekordboxXml — xml2js DOM-based (più robusto del regex parsing)
// ---------------------------------------------------------------------------

/**
 * Aggiunge nuove TRACK entries al rekordbox.xml esistente via DOM parser.
 * - Parsa l'XML con xml2js
 * - Calcola lastTrackId dalla COLLECTION
 * - Costruisce le nuove entry come oggetti JS
 * - Inserisce in COLLECTION + nelle playlist giuste (per targetFolder)
 * - Serializza di nuovo con BOM UTF-8
 */
async function updateRekordboxXml(xmlPath, newTracks) {
  if (!fs.existsSync(xmlPath)) {
    throw new Error(`rekordbox.xml non trovato: ${xmlPath}`);
  }
  if (!newTracks || newTracks.length === 0) {
    return { added: 0, xmlPath };
  }

  const doc = await parseRekordboxXml(xmlPath);
  const djPl = doc?.DJ_PLAYLISTS;
  if (!djPl) throw new Error('Formato non valido: DJ_PLAYLISTS root mancante');

  // ── COLLECTION ─────────────────────────────────────────────────────────
  const collection = Array.isArray(djPl.COLLECTION) ? djPl.COLLECTION[0] : djPl.COLLECTION;
  if (!collection) throw new Error('Formato non valido: COLLECTION mancante');

  const existingTracks = Array.isArray(collection.TRACK) ? collection.TRACK : [];
  const lastId = existingTracks.reduce((max, t) => {
    const id = parseInt(t?.$?.TrackID, 10);
    return Number.isFinite(id) && id > max ? id : max;
  }, 0);

  // Assegna TrackID ai nuovi
  const trackIdMap = new Map();
  newTracks.forEach((t, i) => {
    const newId = lastId + i + 1;
    t.rekordboxTrackId = newId;
    trackIdMap.set(t.id, newId);
  });

  // Costruisci l'attributo-set di ogni TRACK (allineato a rekordboxExportService)
  const { pathToRekordboxUri } = require('../utils/stringUtils');
  const newTrackElements = newTracks.map(t => {
    const bpm = (typeof t.bpm === 'number' && t.bpm > 0) ? Number(t.bpm).toFixed(2) : '0.00';
    const totalTime = Math.round(t.duration || 0);
    const size = Math.round(Number(t.fileSize) || 0);
    const bitrate = Math.round(Number(t.bitrate) || 0);
    const sampleRate = (t.sampleRate && Number(t.sampleRate) > 0)
      ? Number(t.sampleRate).toFixed(1) : '44100.0';
    const location = pathToRekordboxUri(t.newFilePath || t.filePath || '', xmlPath);
    return {
      $: {
        TrackID:      String(t.rekordboxTrackId),
        Name:         t.recognizedTitle || t.localTitle || String(t.fileName || '').replace(/\.[^.]+$/, '') || 'Unknown',
        Artist:       t.recognizedArtist || t.localArtist || 'Unknown',
        Composer:     '',
        Album:        t.recognizedAlbum || '',
        Grouping:     '',
        Genre:        String(t.aiGenre || t.detectedGenre || t.classifiedGenre || ''),
        Kind:         'MP3 File',
        Size:         String(size),
        TotalTime:    String(totalTime),
        DiscNumber:   '0',
        TrackNumber:  '0',
        Year:         '0',
        AverageBpm:   bpm,
        DateModified: new Date().toISOString().slice(0, 10),
        DateAdded:    new Date().toISOString().slice(0, 10),
        BitRate:      String(bitrate),
        SampleRate:   sampleRate,
        Comments:     '',
        PlayCount:    '0',
        Rating:       '0',
        Location:     location,
        Remixer:      '',
        Tonality:     String(t.key || ''),
        Label:        '',
        Mix:          '',
        Colour:       '',
      },
    };
  });

  // Appendi alla COLLECTION e aggiorna Entries
  collection.TRACK = [...existingTracks, ...newTrackElements];
  collection.$.Entries = String(parseInt(collection.$.Entries, 10) + newTracks.length);

  // ── PLAYLISTS ──────────────────────────────────────────────────────────
  const playlists = Array.isArray(djPl.PLAYLISTS) ? djPl.PLAYLISTS[0] : djPl.PLAYLISTS;
  const rootNode = playlists?.NODE?.[0] || playlists?.NODE;

  for (const t of newTracks) {
    const playlistName = t.targetFolder || 'Da Controllare';
    const pl = findPlaylistNode(rootNode, playlistName);
    const keyEntry = { $: { Key: String(t.rekordboxTrackId) } };

    if (pl) {
      pl.TRACK = [...(Array.isArray(pl.TRACK) ? pl.TRACK : []), keyEntry];
      const cur = parseInt(pl.$.Entries, 10) || 0;
      pl.$.Entries = String(cur + 1);
    } else if (rootNode) {
      // Playlist non esiste ancora: creala come figlia diretta del ROOT
      const newPl = {
        $: { Type: '1', Name: playlistName, Entries: '1', KeyType: '0' },
        TRACK: [keyEntry],
      };
      if (!Array.isArray(rootNode.NODE)) rootNode.NODE = [];
      rootNode.NODE.push(newPl);
      if (rootNode.$ && rootNode.$.Count !== undefined) {
        rootNode.$.Count = String((parseInt(rootNode.$.Count, 10) || 0) + 1);
      }
    }
  }

  const xmlOut = buildRekordboxXmlString(doc);
  fs.writeFileSync(xmlPath, xmlOut, 'utf8');
  return { added: newTracks.length, xmlPath };
}

module.exports = {
  loadExistingLibrary,
  checkAgainstExisting,
  updateRekordboxXml,
  parseRekordboxXml,
  DUP_THRESHOLD,
};
