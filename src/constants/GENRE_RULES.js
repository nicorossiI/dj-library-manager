/**
 * src/constants/GENRE_RULES.js
 *
 * Regole di classificazione genere:
 *  - BPM_RANGES: mappa genere -> { min, max } BPM tipici (il matching ritorna candidati).
 *  - KEYWORDS: parole chiave che, se presenti nei tag genere/title/album, forzano il genere.
 *  - GENRE_NORMALIZATION: alias -> nome canonico (es. "drum and bass" -> "DnB").
 *
 * Esporta: GENRE_RULES
 */

'use strict';

const BPM_RANGES = {
  Reggaeton:       { min: 88,  max: 100 },
  HipHop:          { min: 80,  max: 105 },
  Trap:            { min: 130, max: 160 }, // half-time feel su 70-80
  RnB:             { min: 60,  max: 105 },
  Pop:             { min: 95,  max: 130 },
  Afro:            { min: 110, max: 125 },
  AfroHouse:       { min: 118, max: 126 },
  House:           { min: 118, max: 130 },
  DeepHouse:       { min: 115, max: 125 },
  TechHouse:       { min: 122, max: 130 },
  Techno:          { min: 125, max: 140 },
  Trance:          { min: 132, max: 145 },
  DnB:             { min: 160, max: 180 },
  Dubstep:         { min: 135, max: 145 },
  Hardstyle:       { min: 145, max: 160 },
  Disco:           { min: 110, max: 125 },
  FunkSoul:        { min: 90,  max: 120 },
  Latin:           { min: 90,  max: 130 },
  Commercial:      { min: 100, max: 130 },
};

const KEYWORDS = {
  Reggaeton:  ['reggaeton', 'dembow', 'perreo'],
  HipHop:     ['hip hop', 'hip-hop', 'rap', 'boom bap'],
  Trap:       ['trap'],
  RnB:        ['r&b', 'rnb', 'r and b'],
  AfroHouse:  ['afro house', 'afrohouse', 'afro-house'],
  Afro:       ['afro', 'amapiano', 'afrobeats', 'afrobeat'],
  DeepHouse:  ['deep house'],
  TechHouse:  ['tech house'],
  House:      ['house'],
  Techno:     ['techno'],
  Trance:     ['trance', 'psytrance'],
  DnB:        ['drum and bass', 'drum & bass', 'dnb', 'd&b', 'jungle'],
  Dubstep:    ['dubstep', 'riddim'],
  Hardstyle:  ['hardstyle', 'hardcore'],
  Disco:      ['disco', 'nu disco', 'nu-disco'],
  FunkSoul:   ['funk', 'soul', 'motown'],
  Latin:      ['salsa', 'bachata', 'merengue', 'cumbia', 'latin'],
  Pop:        ['pop'],
  Commercial: ['commercial', 'radio edit', 'top 40'],
};

const GENRE_NORMALIZATION = {
  'drum and bass': 'DnB',
  'drum & bass':   'DnB',
  'd&b':           'DnB',
  'dnb':           'DnB',
  'r&b':           'RnB',
  'rnb':           'RnB',
  'hip-hop':       'HipHop',
  'hip hop':       'HipHop',
  'afro house':    'AfroHouse',
  'afrohouse':     'AfroHouse',
  'deep house':    'DeepHouse',
  'tech house':    'TechHouse',
};

// ─────────────────────────────────────────────────────────────────────
// PATH_KEYWORDS: set più ricco per scan path+filename+title (lowercase
// output). Ordine importante: parole più specifiche prima delle generiche
// ("afrohouse" prima di "afro", "tech house" prima di "house").
// ─────────────────────────────────────────────────────────────────────
const PATH_KEYWORDS_ORDERED = [
  ['afrohouse',   ['afrohouse', 'afro house', 'afro-house', 'tribal', 'afro']],
  ['techhouse',   ['tech house', 'techhouse', 'tech-house']],
  ['reggaeton',   ['reggaeton', 'reggaetón', 'reggaeton', 'rkt', 'perreo']],
  ['dembow',      ['dembow']],
  ['bachata',     ['bachata']],
  ['houselatino', ['house latino', 'latin house', 'houselatino', 'latino']],
  ['dnb',         ['drum and bass', 'drum & bass', 'dnb', 'jungle']],
  ['techno',      ['techno']],
  ['trance',      ['trance', 'psytrance']],
  ['dubstep',     ['dubstep', 'riddim']],
  ['deephouse',   ['deep house']],
  ['house',       ['house']],   // generico: solo se nulla sopra matcha
  ['hardstyle',   ['hardstyle', 'hardcore']],
  ['trap',        ['trap']],
  ['hiphop',      ['hip hop', 'hip-hop', 'rap']],
  ['pop',         ['pop']],
];

// ─────────────────────────────────────────────────────────────────────
// ARTIST_GENRE_HINTS: mappa artista (lowercase) → genere lowercase
// Copertura DJ-relevant per reggaeton/bachata/afrohouse/techhouse.
// ─────────────────────────────────────────────────────────────────────
const ARTIST_GENRE_HINTS = {
  // ── Reggaeton / Latin urban ───────────────────────────────────────
  'bad bunny': 'reggaeton', 'j balvin': 'reggaeton', 'rauw alejandro': 'reggaeton',
  'anuel aa': 'reggaeton', 'daddy yankee': 'reggaeton', 'ozuna': 'reggaeton',
  'don omar': 'reggaeton', 'nicky jam': 'reggaeton', 'feid': 'reggaeton',
  'karol g': 'reggaeton', 'maluma': 'reggaeton', 'arcangel': 'reggaeton',
  'jhay cortez': 'reggaeton', 'myke towers': 'reggaeton', 'jhayco': 'reggaeton',
  'natti natasha': 'reggaeton', 'becky g': 'reggaeton', 'wisin': 'reggaeton',
  'yandel': 'reggaeton', 'tego calderon': 'reggaeton', 'sech': 'reggaeton',
  'lunay': 'reggaeton', 'chencho corleone': 'reggaeton', 'quevedo': 'reggaeton',
  // ── Bachata ───────────────────────────────────────────────────────
  'romeo santos': 'bachata', 'aventura': 'bachata', 'prince royce': 'bachata',
  'juan luis guerra': 'bachata', 'monchy & alexandra': 'bachata',
  // ── Afro house ────────────────────────────────────────────────────
  'black coffee': 'afrohouse', 'keinemusik': 'afrohouse',
  '&me': 'afrohouse', 'adam port': 'afrohouse', 'rampa': 'afrohouse',
  'themba': 'afrohouse', 'caiiro': 'afrohouse', 'enoo napa': 'afrohouse',
  'culoe de song': 'afrohouse', 'shimza': 'afrohouse',
  // ── Tech house ────────────────────────────────────────────────────
  'fisher': 'techhouse', 'chris lake': 'techhouse', 'james hype': 'techhouse',
  'dom dolla': 'techhouse', 'john summit': 'techhouse', 'chloe caillet': 'techhouse',
  'vintage culture': 'techhouse', 'cloonee': 'techhouse', 'mau p': 'techhouse',
  // ── House / Deep ──────────────────────────────────────────────────
  'calvin harris': 'house', 'david guetta': 'house', 'martin garrix': 'house',
  'fred again': 'house', 'peggy gou': 'house',
  // ── Techno ────────────────────────────────────────────────────────
  'charlotte de witte': 'techno', 'amelie lens': 'techno', 'tale of us': 'techno',
  'adam beyer': 'techno',
  // ── Rap/Trap italiano (hiphop come genere proxy) ──────────────────
  'sfera ebbasta': 'hiphop', 'tony effe': 'hiphop', 'fedez': 'hiphop',
  'marracash': 'hiphop', 'salmo': 'hiphop', 'capo plaza': 'hiphop',
  'geolier': 'hiphop', 'lazza': 'hiphop', 'rkomi': 'hiphop',
  'mahmood': 'pop', 'blanco': 'pop', 'irama': 'pop', 'sangiovanni': 'pop',
  'federico bolletta': 'hiphop', 'mattia olivi': 'hiphop',
  // ── LAT/BR/ES extra ────────────────────────────────────────────────
  'mc kevinho': 'reggaeton', 'mc livinho': 'reggaeton',
  'j quiles': 'reggaeton', 'el alfa': 'dembow',
  'adan y eva': 'reggaeton', 'rosalia': 'reggaeton',
  'cucurucho': 'reggaeton', 'chimu dj': 'reggaeton', 'chimu': 'reggaeton',
  'lerica': 'reggaeton', 'lgante': 'reggaeton', 'l-gante': 'reggaeton',
  'samuele brignoccolo': 'hiphop',
  // Reggaeton/Latin ampliati
  'farruko': 'reggaeton', 'justin quiles': 'reggaeton',
  'rochy rd': 'dembow', 'bulin 47': 'dembow',
  'trueno': 'reggaeton', 'duki': 'reggaeton', 'bizarrap': 'reggaeton',
  'bzrp': 'reggaeton', 'paulo londra': 'reggaeton', 'khea': 'reggaeton',
  'tiago pzk': 'reggaeton', 'standly': 'reggaeton', 'rusherking': 'reggaeton',
  'rei': 'reggaeton', 'paloma mami': 'reggaeton', 'dei v': 'reggaeton',
  'rels b': 'reggaeton', 'morad': 'reggaeton',
  'villano antillano': 'reggaeton', 'pam': 'reggaeton',
  // Hip Hop italiano ampliato
  'liberato': 'hiphop', 'luche': 'hiphop', 'nino brown': 'hiphop',
  'villabanks': 'hiphop', 'ernia': 'hiphop',
  'gue pequeno': 'hiphop', 'guè pequeno': 'hiphop', 'gue': 'hiphop',
  'jake la furia': 'hiphop', 'dark polo gang': 'hiphop', 'pyrex': 'hiphop',
  'neo solaris': 'hiphop', 'uwaie': 'hiphop', 'ossessione': 'hiphop',
  'guido dj': 'hiphop',
};

// ─────────────────────────────────────────────────────────────────────
// ARTIST_LANG_HINTS: artista (lowercase) → lingua ISO639-1
// Usato quando la lingua non è esplicita: se il nome file contiene
// un artista mappato qui, la lingua viene dedotta senza franc.
// ─────────────────────────────────────────────────────────────────────
const ARTIST_LANG_HINTS = {
  // ── Italiano ──────────────────────────────────────────────────────
  'sfera ebbasta': 'it', 'tony effe': 'it', 'fedez': 'it',
  'marracash': 'it', 'salmo': 'it', 'capo plaza': 'it',
  'geolier': 'it', 'lazza': 'it', 'rkomi': 'it',
  'mahmood': 'it', 'blanco': 'it', 'irama': 'it', 'sangiovanni': 'it',
  'federico bolletta': 'it', 'mattia olivi': 'it',
  'ghali': 'it', 'gue': 'it', 'guè': 'it', 'jake la furia': 'it',
  'tedua': 'it', 'madame': 'it', 'shiva': 'it', 'baby gang': 'it',
  'thasup': 'it', 'emis killa': 'it', 'dargen d amico': 'it',
  'anna': 'it', 'elisa': 'it', 'vasco rossi': 'it', 'ultimo': 'it',
  // ── Spagnolo / LAT ────────────────────────────────────────────────
  'bad bunny': 'es', 'j balvin': 'es', 'rauw alejandro': 'es',
  'anuel aa': 'es', 'daddy yankee': 'es', 'ozuna': 'es',
  'don omar': 'es', 'nicky jam': 'es', 'feid': 'es',
  'karol g': 'es', 'maluma': 'es', 'arcangel': 'es',
  'jhay cortez': 'es', 'myke towers': 'es', 'jhayco': 'es',
  'natti natasha': 'es', 'becky g': 'es', 'wisin': 'es', 'yandel': 'es',
  'tego calderon': 'es', 'sech': 'es', 'lunay': 'es',
  'chencho corleone': 'es', 'quevedo': 'es', 'rosalia': 'es',
  'romeo santos': 'es', 'aventura': 'es', 'prince royce': 'es',
  'juan luis guerra': 'es',
  'mc kevinho': 'es', 'mc livinho': 'es', 'j quiles': 'es',
  'el alfa': 'es', 'adan y eva': 'es', 'cucurucho': 'es', 'chimu dj': 'es',
  'chimu': 'es', 'lerica': 'es', 'lgante': 'es', 'l-gante': 'es',
  'samuele brignoccolo': 'it',
  // Reggaeton/Latin ES ampliati
  'farruko': 'es', 'justin quiles': 'es', 'rochy rd': 'es', 'bulin 47': 'es',
  'trueno': 'es', 'duki': 'es', 'bizarrap': 'es', 'bzrp': 'es',
  'paulo londra': 'es', 'khea': 'es', 'tiago pzk': 'es',
  'standly': 'es', 'rusherking': 'es', 'rei': 'es',
  'paloma mami': 'es', 'dei v': 'es', 'rels b': 'es',
  'morad': 'es', 'villano antillano': 'es', 'pam': 'es',
  // IT ampliati
  'liberato': 'it', 'luche': 'it', 'nino brown': 'it',
  'villabanks': 'it', 'ernia': 'it',
  'gue pequeno': 'it', 'guè pequeno': 'it', 'gue': 'it',
  'jake la furia': 'it', 'dark polo gang': 'it', 'pyrex': 'it',
  'neo solaris': 'it', 'uwaie': 'it', 'ossessione': 'it',
  'guido dj': 'it',
  // ── Inglese ───────────────────────────────────────────────────────
  'missy elliott': 'en', 'avicii': 'en', 'rihanna': 'en',
  'drake': 'en', 'beyonce': 'en', 'beyoncé': 'en', 'kanye west': 'en',
  'travis scott': 'en', 'kendrick lamar': 'en', 'post malone': 'en',
  'the weeknd': 'en', 'ariana grande': 'en', 'taylor swift': 'en',
  'lmfao': 'en', 'lil nas x': 'en', 'doja cat': 'en', 'sza': 'en',
  'calvin harris': 'en', 'david guetta': 'en', 'fisher': 'en',
  'chris lake': 'en', 'james hype': 'en', 'dom dolla': 'en',
  'john summit': 'en', 'cloonee': 'en',
};

// ─────────────────────────────────────────────────────────────────────
// INSTRUMENTAL_KEYWORDS — keyword per MARCARE esplicitamente una
// traccia come strumentale. Solo queste → "Strumentali". Lingua unknown
// NON implica instrumental.
// ─────────────────────────────────────────────────────────────────────
const INSTRUMENTAL_KEYWORDS = [
  'instrumental', 'instru ', 'instru.', '(instru)', '[instru]',
  'karaoke', 'acapella', 'acappella',
  'beat only', 'no vocal', 'no vocals', 'without vocals',
];

const GENRE_RULES = Object.freeze({
  BPM_RANGES,
  KEYWORDS,
  GENRE_NORMALIZATION,
  PATH_KEYWORDS_ORDERED,
  ARTIST_GENRE_HINTS,
  ARTIST_LANG_HINTS,
  INSTRUMENTAL_KEYWORDS,
});

module.exports = { GENRE_RULES };
