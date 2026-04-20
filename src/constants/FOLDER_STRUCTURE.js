/**
 * src/constants/FOLDER_STRUCTURE.js
 *
 * Nuova struttura DJ professionale — 10 cartelle PIATTE per genere/energia.
 *
 * REGOLE:
 *  - La cartella si basa sul genere della BASE audio (aiGenre)
 *  - Mashup/edit vanno nella cartella del genere della BASE
 *  - La lingua NON determina più la cartella (va nel tag ID3)
 *  - Niente sottocartelle Singoli / Mashup e Edit
 *  - Tutto piatto dentro la cartella genere
 *
 * Esempi:
 *   "Yo Perreo Sola" base afrohouse → "Afro House"
 *   "Tran Tran" base techhouse      → "Tech House"
 *   "Bad Bunny - Titi" originale    → "Reggaeton"
 *   Mix SoundCloud 45min            → "Mix e Set"
 */

'use strict';

const FOLDER_MAP = {
  // ── RISCALDAMENTO ────────────────────────────
  // Apertura serata, BPM 85-100, pista vuota
  // Reggaeton lento, bachata morbida, hit note
  'riscaldamento': 'Riscaldamento',

  // ── REGGAETON ────────────────────────────────
  // BPM 88-100, singoli originali
  // NON include edit con base house (→ vanno in AFRO HOUSE/TECH HOUSE)
  'reggaeton': 'Reggaeton',

  // ── AFRO HOUSE ───────────────────────────────
  // BPM 108-126, sia singoli afrohouse
  // SIA edit/mashup di canzoni latine con base afrohouse
  'afrohouse': 'Afro House',

  // ── TECH HOUSE ───────────────────────────────
  // BPM 120-132, sia singoli techhouse
  // SIA edit/mashup di canzoni con base techhouse
  'techhouse': 'Tech House',

  // ── DEEP HOUSE ───────────────────────────────
  // BPM 118-128
  'deephouse': 'Deep House',

  // ── DEMBOW ───────────────────────────────────
  // BPM 116-130
  'dembow': 'Dembow',

  // ── BACHATA E TROPICALE ──────────────────────
  // Bachata, salsa, merengue, qualsiasi BPM
  'bachata':  'Bachata e Tropicale',
  'salsa':    'Bachata e Tropicale',
  'tropical': 'Bachata e Tropicale',

  // ── HIP HOP E TRAP ───────────────────────────
  // BPM 80-100
  'hiphop': 'Hip Hop e Trap',
  'trap':   'Hip Hop e Trap',

  // ── TECHNO ───────────────────────────────────
  // BPM 130+
  'techno': 'Techno',

  // ── SPECIALI (sempre piatti) ─────────────────
  'mix': 'Mix e Set',
  'set': 'Mix e Set',

  // ── FALLBACK ─────────────────────────────────
  'unknown': 'Da Controllare',
  'none':    'Da Controllare',
};

// Tutte le cartelle sono PIATTE — nessuna sottocartella
// La distinzione singolo/mashup/edit è nel NOME FILE
// La lingua è nel TAG ID3 (Comment/Grouping)
const ALL_FOLDERS_FLAT = new Set(Object.values(FOLDER_MAP));

// Lista cartelle in ordine logico serata
// (usata per creare struttura USB ordinata e playlist Rekordbox)
const FOLDER_ORDER = [
  'Riscaldamento',
  'Reggaeton',
  'Afro House',
  'Tech House',
  'Deep House',
  'Dembow',
  'Bachata e Tropicale',
  'Hip Hop e Trap',
  'Techno',
  'Mix e Set',
  'Da Controllare',
];

// ── Genre labels per etichette [Genere Edit] nei nomi file ──
const GENRE_LABELS = {
  'afrohouse': 'Afro House',
  'techhouse': 'Tech House',
  'deephouse': 'Deep House',
  'dembow':    'Dembow',
  'reggaeton': 'Reggaeton',
  'bachata':   'Bachata',
  'salsa':     'Salsa',
  'tropical':  'Tropical',
  'hiphop':    'Hip Hop',
  'trap':      'Trap',
  'techno':    'Techno',
};

function genreLabel(genreKey) {
  if (!genreKey) return '';
  const k = String(genreKey).toLowerCase().replace(/[\s\-_]+/g, '');
  return GENRE_LABELS[k] || '';
}

/**
 * Risolve la cartella finale per un track.
 * REGOLA PRINCIPALE: se è un edit/mashup con base diversa
 * dalle vocals → usa il genere della BASE (non delle vocals).
 */
function resolveFolder(track) {
  if (!track) return 'Da Controllare';

  // Mix lunghi → sempre Mix e Set
  if (track.fileType === 'mix' || track.type === 'mix' || track.isMix
      || (Number(track.duration) || 0) > 480) {
    return 'Mix e Set';
  }

  // Track in errore → Da Controllare
  if (track.status === 'error') return 'Da Controllare';

  // Genere della BASE audio (da AI o fallback a classificatore/detect)
  // Se edit/mashup → questo è il genere che conta
  const baseGenre = track.aiGenre
    || track.detectedGenre
    || track.classifiedGenre
    || track.targetGenre;

  if (!baseGenre) return 'Da Controllare';

  const key = String(baseGenre).toLowerCase().replace(/[\s\-_]+/g, '');
  return FOLDER_MAP[key] || 'Da Controllare';
}

// ────────────────────────────────────────────────────────────────────
// Retro-compat wrappers (per codice legacy che ancora importa
// resolveTargetFolder / FOLDER_NAMES / FLAT_FOLDERS / SUBFOLDERS).
// ────────────────────────────────────────────────────────────────────

function resolveTargetFolder(track) {
  return resolveFolder(track);
}

// Minimal FOLDER_NAMES shim: tutti i nomi puntano alla nuova cartella piatta.
const FOLDER_NAMES = Object.freeze({
  RISCALDAMENTO: 'Riscaldamento',
  REGGAETON:     'Reggaeton',
  AFRO_HOUSE:    'Afro House',
  TECH_HOUSE:    'Tech House',
  DEEP_HOUSE:    'Deep House',
  DEMBOW:        'Dembow',
  BACHATA:       'Bachata e Tropicale',
  SALSA_TROPICAL:'Bachata e Tropicale',
  HIP_HOP:       'Hip Hop e Trap',
  TECHNO:        'Techno',
  MIX_SET:       'Mix e Set',
  TO_CHECK:      'Da Controllare',
  UNCLASSIFIED:  'Da Controllare',
});

// Tutte flat adesso
const FLAT_FOLDERS = new Set(ALL_FOLDERS_FLAT);
const SUBFOLDERS = Object.freeze({ SINGLES: null, MASHUP: null });

module.exports = {
  FOLDER_MAP,
  ALL_FOLDERS_FLAT,
  FOLDER_ORDER,
  GENRE_LABELS,
  genreLabel,
  resolveFolder,
  // retro-compat
  resolveTargetFolder,
  FOLDER_NAMES,
  FLAT_FOLDERS,
  SUBFOLDERS,
};
