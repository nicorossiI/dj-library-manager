/**
 * src/services/rekordboxExportService.js
 *
 * Genera rekordbox.xml secondo formato ufficiale Pioneer DJ.
 * Compatibile con Rekordbox 5/6/7.
 *
 * INPUT: organizedTracks (Track[]) con newFilePath + rekordboxPlaylistFolder
 *        + rekordboxPlaylistName già popolati dall'organizerService.
 *
 * OUTPUT: file <outputRoot>/rekordbox.xml in UTF-8.
 *
 * Strutture:
 *   <DJ_PLAYLISTS Version="1.0.0">
 *     <PRODUCT .../>
 *     <COLLECTION Entries="N"> ... <TRACK ... /> ... </COLLECTION>
 *     <PLAYLISTS>
 *       <NODE Type="0" Name="ROOT" Count="K">
 *         <NODE Type="0" Name="<Genre folder>" Count="2">
 *           <NODE Type="1" Name="Singoli" Entries="X"> <TRACK Key="N"/> ... </NODE>
 *           <NODE Type="1" Name="Mashup e Edit" Entries="Y"> ... </NODE>
 *         </NODE>
 *         ...
 *         <NODE Type="1" Name="Mix e Set" Entries="Z"> ... </NODE>
 *         <NODE Type="1" Name="Da Classificare" Entries="W"> ... </NODE>
 *       </NODE>
 *     </PLAYLISTS>
 *   </DJ_PLAYLISTS>
 *
 * Esporta:
 *   generateRekordboxXml(tracks, outputRoot)
 *   buildCollectionXml(tracks, trackIdMap)
 *   buildPlaylistsXml(tracks, trackIdMap)
 *   groupTracksByPlaylist(tracks)
 *   validateXml(xmlString, tracks)
 *   xmlEscape(str)
 *
 * Dipendenze: fs, path, FOLDER_STRUCTURE, stringUtils
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { FOLDER_NAMES, SUBFOLDERS } = require('../constants/FOLDER_STRUCTURE');
const { pathToRekordboxUri } = require('../utils/stringUtils');

// ---------------------------------------------------------------------------
// xmlEscape
// ---------------------------------------------------------------------------

function xmlEscape(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Helpers per Track → attributi TRACK
// ---------------------------------------------------------------------------

const KIND_BY_FORMAT = {
  mp3:  'MP3 File',
  wav:  'WAV File',
  flac: 'FLAC File',
  aac:  'AAC File',
  m4a:  'AAC File',
  ogg:  'Ogg Vorbis File',
  aiff: 'AIFF File',
  aif:  'AIFF File',
};

// Rekordbox/iTunes rating mapping: 0-5 stelle → 0/51/102/153/204/255.
// Fonte: pyrekordbox RATING_MAPPING (https://github.com/dylanljones/pyrekordbox).
// Passare un numero 0-5 qui lo codifica nel valore XML atteso da Rekordbox.
const RATING_MAP = { 0: 0, 1: 51, 2: 102, 3: 153, 4: 204, 5: 255 };

function encodeRating(stars) {
  const n = Number(stars);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const clamped = Math.max(0, Math.min(5, Math.round(n)));
  return RATING_MAP[clamped] ?? 0;
}

// ---------------------------------------------------------------------------
// Genre display labels (chiave interna → label leggibile su Rekordbox e CDJ)
// Ispirato da a-rich/DJ-Tools "Build Playlists From Tags": scrivere un Genre
// leggibile permette di filtrare la libreria direttamente sul CDJ senza
// dover aprire Rekordbox o navigare le playlist.
// ---------------------------------------------------------------------------

const GENRE_DISPLAY_LABELS = {
  afrohouse:   'Afro House',
  techhouse:   'Tech House',
  deephouse:   'Deep House',
  house:       'House',
  houselatino: 'House Latino',
  reggaeton:   'Reggaeton',
  dembow:      'Dembow',
  bachata:     'Bachata',
  techno:      'Techno',
  trance:      'Trance',
  dnb:         'Drum and Bass',
  dubstep:     'Dubstep',
  hardstyle:   'Hardstyle',
  trap:        'Trap',
  hiphop:      'Hip Hop',
  pop:         'Pop',
};

const LANG_LABELS = {
  es: 'ES', it: 'IT', en: 'EN', fr: 'FR', pt: 'PT', de: 'DE', nl: 'NL',
  mixed: 'MIX', instrumental: 'INSTR', unknown: '?',
};

function genreLabel(genreKey) {
  if (!genreKey) return '';
  const key = String(genreKey).toLowerCase();
  return GENRE_DISPLAY_LABELS[key] || String(genreKey);
}

function langLabel(langKey) {
  if (!langKey) return '';
  return LANG_LABELS[String(langKey).toLowerCase()] || String(langKey).toUpperCase();
}

// Comments "DJLM: <Genre> | <LANG> | <BPM> | <Key>" — visibile su CDJ hardware
// senza aprire Rekordbox. Inserisce solo i campi popolati.
function buildDjlmComment(t) {
  const parts = [];
  const g = genreLabel(t.detectedGenre);
  if (g) parts.push(g);
  const l = langLabel(t.vocalsLanguage);
  if (l) parts.push(l);
  const bpmRaw = (typeof t.bpm === 'number' && t.bpm > 0) ? Math.round(t.bpm) : null;
  if (bpmRaw) parts.push(`${bpmRaw}`);
  if (t.key) parts.push(String(t.key));
  if (parts.length === 0) return '';
  return `DJLM: ${parts.join(' | ')}`;
}

function bestTitle(t) {
  return (
    t.recognizedTitle ||
    t.localTitle ||
    String(t.fileName || '').replace(/\.[^.]+$/, '') ||
    'Unknown'
  );
}

function bestArtist(t) {
  return t.recognizedArtist || t.localArtist || 'Unknown';
}

function todayIso() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// buildCollectionXml
// ---------------------------------------------------------------------------

function trackElement(t, rekordboxId) {
  const kind = KIND_BY_FORMAT[String(t.format || '').toLowerCase()] || 'MP3 File';
  const totalTime = Math.round(t.duration || 0);
  const bpm = (typeof t.bpm === 'number' && t.bpm > 0) ? Number(t.bpm).toFixed(2) : '0.00';
  const sampleRate = (t.sampleRate && Number(t.sampleRate) > 0)
    ? Number(t.sampleRate).toFixed(1) : '44100.0';
  const bitrate = Math.round(Number(t.bitrate) || 0);
  const size = Math.round(Number(t.fileSize) || 0);
  const location = pathToRekordboxUri(t.newFilePath || t.filePath || '');
  // Comments: "DJLM: Afro House | ES | 112 | 8A" — filtrabile su CDJ Pioneer.
  // Se disponibile, appende anche il nome file originale (backup).
  const djlmLine = buildDjlmComment(t);
  const origLine = t.originalFileName ? `DJLM_ORIGINAL: ${t.originalFileName}` : '';
  const comments = [djlmLine, origLine].filter(Boolean).join(' // ');
  const today = todayIso();
  const rating = encodeRating(t.rating);
  const genreHuman = genreLabel(t.detectedGenre);

  return (
`    <TRACK
      TrackID="${rekordboxId}"
      Name="${xmlEscape(bestTitle(t))}"
      Artist="${xmlEscape(bestArtist(t))}"
      Composer=""
      Album="${xmlEscape(t.recognizedAlbum || '')}"
      Grouping=""
      Genre="${xmlEscape(genreHuman)}"
      Kind="${xmlEscape(kind)}"
      Size="${size}"
      TotalTime="${totalTime}"
      DiscNumber="0"
      TrackNumber="0"
      Year="0"
      AverageBpm="${bpm}"
      DateModified="${today}"
      DateAdded="${today}"
      BitRate="${bitrate}"
      SampleRate="${sampleRate}"
      Comments="${xmlEscape(comments)}"
      PlayCount="0"
      Rating="${rating}"
      Location="${location}"
      Remixer=""
      Tonality="${xmlEscape(t.key || '')}"
      Label=""
      Mix=""
      Colour=""
    />`
  );
}

function buildCollectionXml(tracks, trackIdMap) {
  return (tracks || [])
    .map(t => trackElement(t, trackIdMap.get(t.id)))
    .join('\n');
}

// ---------------------------------------------------------------------------
// groupTracksByPlaylist
// ---------------------------------------------------------------------------

/**
 * Ritorna Map<folderName, structure>
 *   - structure { direct: Track[] }                      → playlist diretta (no subfolder)
 *   - structure { 'Singoli': Track[], 'Mashup e Edit': Track[] } → folder con subfolders
 *
 * Tracks senza rekordboxPlaylistFolder finiscono in "Da Classificare" (direct)
 * per evitare di perderle nel rekordbox.xml.
 */
function groupTracksByPlaylist(tracks) {
  const groups = new Map();

  for (const t of tracks || []) {
    let folder = t.rekordboxPlaylistFolder || '';
    let sub = t.rekordboxPlaylistName || '';

    // Fallback: se manca folder, derive da targetFolder; se ancora niente → Da Classificare
    if (!folder && t.targetFolder) {
      const parts = String(t.targetFolder).split(/[\\/]+/).filter(Boolean);
      folder = parts[0] || FOLDER_NAMES.UNCLASSIFIED;
      sub = parts[1] || '';
    }
    if (!folder) folder = FOLDER_NAMES.UNCLASSIFIED;

    if (!sub) {
      // Playlist diretta (Mix e Set, Da Classificare, ecc.)
      if (!groups.has(folder)) groups.set(folder, { direct: [] });
      const entry = groups.get(folder);
      if (!Array.isArray(entry.direct)) {
        // collisione tra direct e folder-with-subs: fonde sub vuoto
        entry.direct = [];
      }
      entry.direct.push(t);
    } else {
      // Folder + subfolder
      if (!groups.has(folder)) groups.set(folder, {});
      const entry = groups.get(folder);
      if (entry.direct) {
        // edge case: era già diretto, convertiamo in struttura mista (improbabile)
      }
      if (!Array.isArray(entry[sub])) entry[sub] = [];
      entry[sub].push(t);
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// buildPlaylistsXml
// ---------------------------------------------------------------------------

// Ordine di apparizione folder/playlist in PLAYLISTS
// Ordine visualizzazione in Rekordbox (gerarchia radicata).
// Deduplicato via Set (molti alias puntano alla stessa cartella).
const FOLDER_ORDER = [...new Set([
  // Afro House
  FOLDER_NAMES.AFRO_HOUSE_ES, FOLDER_NAMES.AFRO_HOUSE_IT,
  FOLDER_NAMES.AFRO_HOUSE_ITES, FOLDER_NAMES.AFRO_HOUSE_EN,
  FOLDER_NAMES.AFRO_HOUSE_MIXED, FOLDER_NAMES.AFRO_HOUSE_INSTR,
  // Tech House
  FOLDER_NAMES.TECH_HOUSE_ES, FOLDER_NAMES.TECH_HOUSE_IT,
  FOLDER_NAMES.TECH_HOUSE_ITES, FOLDER_NAMES.TECH_HOUSE_EN,
  FOLDER_NAMES.TECH_HOUSE_MIXED, FOLDER_NAMES.TECH_HOUSE_INSTR,
  // Deep House
  FOLDER_NAMES.DEEP_HOUSE_ES, FOLDER_NAMES.DEEP_HOUSE_IT,
  FOLDER_NAMES.DEEP_HOUSE_ITES, FOLDER_NAMES.DEEP_HOUSE_EN,
  FOLDER_NAMES.DEEP_HOUSE_MIXED, FOLDER_NAMES.DEEP_HOUSE_INSTR,
  // House Latino / House Misto
  FOLDER_NAMES.HOUSE_LATINO_ES, FOLDER_NAMES.HOUSE_MIXED,
  // Reggaeton
  FOLDER_NAMES.REGGAETON_ES, FOLDER_NAMES.REGGAETON_MIXED,
  // Dembow
  FOLDER_NAMES.DEMBOW_ES, FOLDER_NAMES.DEMBOW_MIXED,
  // Bachata
  FOLDER_NAMES.BACHATA_ES,
  // Hip Hop
  FOLDER_NAMES.HIPHOP_IT, FOLDER_NAMES.HIPHOP_EN, FOLDER_NAMES.HIPHOP_ES,
  // Strumentali / Mondo
  FOLDER_NAMES.TECHNO, FOLDER_NAMES.SALSA_TROPICAL,
  // Speciali
  FOLDER_NAMES.MIX_SET, FOLDER_NAMES.MASHUP_VARI, FOLDER_NAMES.TO_CHECK,
])];

const SUB_ORDER = [SUBFOLDERS.SINGLES, SUBFOLDERS.MASHUP];

function trackKeyLine(rekordboxId, indent) {
  return `${indent}<TRACK Key="${rekordboxId}"/>`;
}

function buildDirectPlaylistNode(name, tracks, trackIdMap) {
  const lines = tracks.map(t => trackKeyLine(trackIdMap.get(t.id), '        ')).join('\n');
  return (
`      <NODE Type="1" Name="${xmlEscape(name)}" Entries="${tracks.length}" KeyType="0">
${lines}
      </NODE>`
  );
}

function buildFolderNode(folderName, subStructure, trackIdMap) {
  // Ordina sub: Singoli prima, poi Mashup e Edit, poi eventuali altri
  const subNames = [
    ...SUB_ORDER.filter(s => Array.isArray(subStructure[s]) && subStructure[s].length > 0),
    ...Object.keys(subStructure)
        .filter(k => k !== 'direct' && !SUB_ORDER.includes(k))
        .filter(k => Array.isArray(subStructure[k]) && subStructure[k].length > 0),
  ];

  if (subNames.length === 0) return null; // folder vuoto: skip

  const subBlocks = subNames.map(subName => {
    const subTracks = subStructure[subName];
    const lines = subTracks.map(t => trackKeyLine(trackIdMap.get(t.id), '          ')).join('\n');
    return (
`        <NODE Type="1" Name="${xmlEscape(subName)}" Entries="${subTracks.length}" KeyType="0">
${lines}
        </NODE>`
    );
  });

  return (
`      <NODE Type="0" Name="${xmlEscape(folderName)}" Count="${subBlocks.length}">
${subBlocks.join('\n')}
      </NODE>`
  );
}

function buildPlaylistsXml(tracks, trackIdMap) {
  const groups = groupTracksByPlaylist(tracks);

  // Ordine: prima quelli noti in FOLDER_ORDER, poi eventuali sconosciuti
  const orderedNames = [
    ...FOLDER_ORDER.filter(n => groups.has(n)),
    ...[...groups.keys()].filter(n => !FOLDER_ORDER.includes(n)),
  ];

  const blocks = [];
  for (const name of orderedNames) {
    const struct = groups.get(name);
    if (struct.direct) {
      if (struct.direct.length === 0) continue;
      blocks.push(buildDirectPlaylistNode(name, struct.direct, trackIdMap));
    } else {
      const node = buildFolderNode(name, struct, trackIdMap);
      if (node) blocks.push(node);
    }
  }

  return (
`  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="${blocks.length}">
${blocks.join('\n')}
    </NODE>
  </PLAYLISTS>`
  );
}

// ---------------------------------------------------------------------------
// validateXml
// ---------------------------------------------------------------------------

function validateXml(xmlString, tracks) {
  const errors = [];
  const totalTracks = (tracks || []).length;

  // 1) COLLECTION Entries
  const colMatch = xmlString.match(/<COLLECTION\s+Entries="(\d+)"/);
  if (!colMatch) {
    errors.push('COLLECTION element mancante o Entries non trovato');
  } else if (Number(colMatch[1]) !== totalTracks) {
    errors.push(`COLLECTION Entries=${colMatch[1]} ≠ tracks.length=${totalTracks}`);
  }

  // 2) Conta TRACK in COLLECTION (con TrackID, no Key)
  const trackIdMatches = xmlString.match(/<TRACK\s+TrackID="(\d+)"/g) || [];
  if (trackIdMatches.length !== totalTracks) {
    errors.push(`COLLECTION contiene ${trackIdMatches.length} <TRACK TrackID...>, atteso ${totalTracks}`);
  }

  // 3) Unicità TrackID
  const idSet = new Set();
  const dupIds = [];
  for (const m of trackIdMatches) {
    const id = m.match(/TrackID="(\d+)"/)[1];
    if (idSet.has(id)) dupIds.push(id);
    idSet.add(id);
  }
  if (dupIds.length) errors.push(`TrackID duplicati in COLLECTION: ${[...new Set(dupIds)].join(', ')}`);

  // 4) Tutte le Location ben formate
  const locRe = /Location="([^"]*)"/g;
  let locMatch;
  let locCount = 0;
  while ((locMatch = locRe.exec(xmlString)) !== null) {
    locCount++;
    const loc = locMatch[1];
    if (!loc.startsWith('file://localhost/')) {
      errors.push(`Location non valida: "${loc.slice(0, 80)}"`);
      if (errors.length > 10) break; // evita output gigante
    }
  }
  if (locCount !== totalTracks) {
    errors.push(`Conteggio Location=${locCount} ≠ tracks.length=${totalTracks}`);
  }

  // 5) ROOT NODE Count = numero figli diretti
  const rootMatch = xmlString.match(/<NODE\s+Type="0"\s+Name="ROOT"\s+Count="(\d+)">/);
  if (!rootMatch) {
    errors.push('ROOT NODE mancante o malformato');
  }

  // 6) Ogni <TRACK Key="N"/> nelle PLAYLISTS deve esistere in COLLECTION
  const playlistsBlock = xmlString.split('<PLAYLISTS>')[1];
  if (playlistsBlock) {
    const keyRe = /<TRACK\s+Key="(\d+)"\s*\/>/g;
    let k;
    const orphans = [];
    while ((k = keyRe.exec(playlistsBlock)) !== null) {
      if (!idSet.has(k[1])) orphans.push(k[1]);
    }
    if (orphans.length) {
      errors.push(`PLAYLISTS referenziano TrackID inesistenti in COLLECTION: ${[...new Set(orphans)].slice(0, 10).join(', ')}`);
    }
  }

  // 7) NODE Type=1 Entries deve combaciare col numero di TRACK Key dentro
  const playlistNodeRe = /<NODE\s+Type="1"[^>]*Name="([^"]+)"[^>]*Entries="(\d+)"[^>]*>([\s\S]*?)<\/NODE>/g;
  let pn;
  while ((pn = playlistNodeRe.exec(xmlString)) !== null) {
    const declared = Number(pn[2]);
    const actual = (pn[3].match(/<TRACK\s+Key="\d+"\s*\/>/g) || []).length;
    if (declared !== actual) {
      errors.push(`Playlist "${pn[1]}" Entries=${declared} ma contiene ${actual} <TRACK Key/>`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      'Rekordbox XML validation FAILED:\n  - ' + errors.join('\n  - ')
    );
  }
}

// ---------------------------------------------------------------------------
// generateRekordboxXml (orchestratore)
// ---------------------------------------------------------------------------

async function generateRekordboxXml(organizedTracks, outputRoot) {
  if (!outputRoot) throw new Error('generateRekordboxXml: outputRoot mancante');
  const tracks = organizedTracks || [];

  // 1) TrackID progressivi
  const trackIdMap = new Map();
  tracks.forEach((t, i) => {
    const id = i + 1;
    trackIdMap.set(t.id, id);
    t.rekordboxTrackId = id;
  });

  // 2-3) Sezioni XML
  const collectionXml = buildCollectionXml(tracks, trackIdMap);
  const playlistsXml = buildPlaylistsXml(tracks, trackIdMap);

  // 4) Assembla
  const xml =
`<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="DJ Library Manager" Version="1.0.0" Company="Nicho DJ Tools"/>
  <COLLECTION Entries="${tracks.length}">
${collectionXml}
  </COLLECTION>
${playlistsXml}
</DJ_PLAYLISTS>
`;

  // 5) Validazione (lancia su errore)
  validateXml(xml, tracks);

  // 6) Salva su disco
  const xmlPath = path.join(outputRoot, 'rekordbox.xml');
  await fsp.writeFile(xmlPath, xml, 'utf8');

  // Aggiorna status
  tracks.forEach(t => {
    if (t.status === 'organized' || t.status === 'renamed' || !t.status) {
      t.status = 'exported';
    }
  });

  return xmlPath;
}

module.exports = {
  generateRekordboxXml,
  buildCollectionXml,
  buildPlaylistsXml,
  groupTracksByPlaylist,
  validateXml,
  xmlEscape,
  encodeRating,
  RATING_MAP,
  genreLabel,
  langLabel,
  buildDjlmComment,
  GENRE_DISPLAY_LABELS,
  LANG_LABELS,
};
