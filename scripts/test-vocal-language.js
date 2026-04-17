'use strict';
const {
  artistMatchesText,
  detectLanguageFromArtists,
  ARTISTS_ES, ARTISTS_IT, ARTISTS_EN,
} = require('../src/services/vocalLanguageService');

const testCases = [
  // Deve matchare
  { text: 'bad bunny - titi',          artist: 'bad bunny', expected: true  },
  { text: 'bad_bunny_spotdown',        artist: 'bad bunny', expected: true  },
  { text: 'j balvin x bad bunny',      artist: 'bad bunny', expected: true  },
  // NON deve matchare
  { text: 'badger bunny hop',          artist: 'bad bunny', expected: false },
  { text: 'embed bunny',               artist: 'bad bunny', expected: false },
  // Extra sanity
  { text: 'SEBASTIAN YATRA - Como',    artist: 'sebastian yatra', expected: true },
  { text: 'Sebastián Yatra - Pareja',  artist: 'sebastian yatra', expected: true }, // diacritics
  { text: 'feid.dj.scuff - intro',     artist: 'dj scuff', expected: true },
  { text: 'travis scottie - tour',     artist: 'travis scott', expected: false },
  { text: 'j.cole - middle',           artist: 'j cole', expected: true },
];

let pass = 0, fail = 0;
for (const tc of testCases) {
  // Normalizza il text come fa il service (lowercase + strip diacritics)
  const norm = tc.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const got = artistMatchesText(tc.artist, norm);
  const ok = got === tc.expected;
  console.log(`${ok ? '\u2705' : '\u274C'} [${tc.expected}] "${tc.text}" ~ "${tc.artist}"  → ${got}`);
  if (ok) pass++; else fail++;
}

console.log(`\n${pass}/${pass + fail} passed`);
console.log('ARTISTS sizes: ES=%d IT=%d EN=%d', ARTISTS_ES.size, ARTISTS_IT.size, ARTISTS_EN.size);

// Language detection sanity
const tracks = [
  { fileName: 'Bad Bunny - Titi (Afrohouse Edit).mp3', expected: 'es' },
  { fileName: 'J Balvin x Bad Bunny - Mi Gente.mp3',   expected: 'es' },
  { fileName: 'Drake - One Dance.mp3',                  expected: 'en' },
  { fileName: 'Sfera Ebbasta - Rockstar.mp3',           expected: 'it' },
  { fileName: 'Peso Pluma - Ella Baila Sola.mp3',       expected: 'es' },
  { fileName: 'Central Cee - Sprinter.mp3',             expected: 'en' },
  { fileName: 'badger_bunny_trail.mp3',                 expected: null },
];
console.log('\n-- Language detection --');
for (const t of tracks) {
  // Use same pipeline as service: extract + normalize
  const text = (t.fileName.replace(/\.mp3$/i, '').replace(/_/g, ' ')).toLowerCase();
  const lang = detectLanguageFromArtists(text);
  const ok = lang === t.expected;
  console.log(`${ok ? '\u2705' : '\u274C'} [${t.expected}] ${t.fileName} → ${lang}`);
}

process.exit(fail === 0 ? 0 : 1);
