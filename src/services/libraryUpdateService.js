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
// updateRekordboxXml
// ---------------------------------------------------------------------------

/**
 * Aggiunge nuove TRACK entries al rekordbox.xml esistente. NON rigenera da zero.
 * Le tracce vengono appese al blocco COLLECTION e alle playlist giuste via
 * rekordboxPlaylistFolder/rekordboxPlaylistName.
 *
 * Nota: approccio regex-based come da spec utente. Sufficiente per rekordbox.xml
 * generato da questo stesso tool (struttura controllata). Per XML arbitrari
 * sarebbe meglio un parser DOM, ma qui conosciamo il formato.
 */
async function updateRekordboxXml(xmlPath, newTracks) {
  if (!fs.existsSync(xmlPath)) {
    throw new Error(`rekordbox.xml non trovato: ${xmlPath}`);
  }
  if (!newTracks || newTracks.length === 0) {
    return { added: 0, xmlPath };
  }

  const { buildCollectionXml } = require('./rekordboxExportService');

  let xml = fs.readFileSync(xmlPath, 'utf8');

  // Trova ultimo TrackID usato → le nuove partono da lastId+1
  const ids = [...xml.matchAll(/TrackID="(\d+)"/g)].map(m => parseInt(m[1], 10));
  const lastId = ids.length > 0 ? Math.max(...ids) : 0;

  const trackIdMap = new Map();
  newTracks.forEach((t, i) => {
    const newId = lastId + i + 1;
    t.rekordboxTrackId = newId;
    trackIdMap.set(t.id, newId);
  });

  // Genera le nuove TRACK entries
  const newTrackXml = buildCollectionXml(newTracks, trackIdMap);

  // Aggiorna COLLECTION Entries="..." + appende le TRACK prima di </COLLECTION>
  const collectionEntriesMatch = xml.match(/<COLLECTION\s+Entries="(\d+)"/);
  const oldCount = collectionEntriesMatch ? parseInt(collectionEntriesMatch[1], 10) : 0;
  const newCount = oldCount + newTracks.length;

  xml = xml.replace(
    /<COLLECTION\s+Entries="\d+"/,
    `<COLLECTION Entries="${newCount}"`
  );
  xml = xml.replace(
    /<\/COLLECTION>/,
    `${newTrackXml}\n  </COLLECTION>`
  );

  // Aggiungi ciascuna traccia alla playlist giusta. Incrementa Entries della
  // playlist e appende <TRACK Key="..."/> subito prima di </NODE>.
  for (const track of newTracks) {
    const playlist = track.rekordboxPlaylistName || track.targetFolder?.split(/[\\/]/).pop() || 'Da Rivedere';
    const trackKeyLine = `      <TRACK Key="${track.rekordboxTrackId}"/>`;
    const safeName = escapeRegex(playlist);

    // Incrementa count Entries
    const countRegex = new RegExp(`(Name="${safeName}"[^>]*Entries=")(\\d+)(")`);
    xml = xml.replace(countRegex, (_, pre, count, post) =>
      `${pre}${parseInt(count, 10) + 1}${post}`
    );

    // Inserisce TRACK prima di </NODE> della playlist
    const playlistNodeRegex = new RegExp(
      `(<NODE\\s+Type="1"\\s+Name="${safeName}"[\\s\\S]*?)(\\n\\s*</NODE>)`
    );
    xml = xml.replace(playlistNodeRegex, (_, head, close) => `${head}\n${trackKeyLine}${close}`);
  }

  fs.writeFileSync(xmlPath, xml, 'utf8');
  return { added: newTracks.length, xmlPath };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  loadExistingLibrary,
  checkAgainstExisting,
  updateRekordboxXml,
  DUP_THRESHOLD,
};
