/**
 * tests/rename.test.js
 *
 * Test unitari per renameService — regole di generazione nome file,
 * con focus su:
 *  - cap MAX_REGEX_INPUT (anti-backtracking)
 *  - labels [Genre Edit] / [Genre Mashup]
 *  - BPM + Key suffix formatting
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateNewFileName,
  formatBpm,
  _internals,
} = require('../src/services/renameService');

const { extractEditType, stripEditAnnotations, splitArtistsForMashup } = _internals;

// ── Edit type extraction ────────────────────────────────────────

test('extractEditType: riconosce parens con keyword', () => {
  assert.equal(extractEditType('Song Title (Afrohouse Edit)'), 'Afrohouse Edit');
  assert.equal(extractEditType('Song [Tech House Blend]'), 'Tech House Blend');
  assert.equal(extractEditType('Song (Extended Mix)'), 'Extended Mix');
});

test('extractEditType: ignora parens senza keyword', () => {
  assert.equal(extractEditType('Song (2024)'), '');
  assert.equal(extractEditType('Song (feat. Artist)'), '');
});

test('extractEditType: null-safe', () => {
  assert.equal(extractEditType(), '');
  assert.equal(extractEditType(null), '');
  assert.equal(extractEditType(''), '');
});

test('extractEditType: cap input 500 char anti-backtracking', () => {
  // 1000 parentesi aperte annidate — con regex vulnerabile bloccherebbe 5s+.
  const evil = '(' .repeat(1000) + 'mashup' + ')'.repeat(1000);
  const start = Date.now();
  const result = extractEditType(evil);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `dovrebbe essere < 500ms, è stato ${elapsed}ms`);
  // Non ci interessa il valore esatto, ma che ritorni velocemente
  assert.equal(typeof result, 'string');
});

// ── Strip edit annotations ──────────────────────────────────────

test('stripEditAnnotations: rimuove parens con keyword', () => {
  assert.equal(
    stripEditAnnotations('Titi Me Pregunto (Afrohouse Edit)'),
    'Titi Me Pregunto',
  );
  // Tutto ciò che sta FUORI dalle parentesi è preservato (anche "Remix" se
  // non è dentro una [])
  assert.equal(
    stripEditAnnotations('Song [Tech House Blend] Remix'),
    'Song Remix',
  );
});

test('stripEditAnnotations: preserva parens neutre', () => {
  assert.equal(stripEditAnnotations('Song (2024)'), 'Song (2024)');
});

test('stripEditAnnotations: cap input', () => {
  const big = 'A'.repeat(10_000) + ' (mashup)';
  const result = stripEditAnnotations(big);
  assert.ok(result.length <= 500);
});

// ── Artist splitting ─────────────────────────────────────────────

test('splitArtistsForMashup: separa con virgola / & / x / vs / feat / ft', () => {
  assert.equal(splitArtistsForMashup('Bad Bunny, J Balvin'), 'Bad Bunny x J Balvin');
  assert.equal(splitArtistsForMashup('Bad Bunny & J Balvin'), 'Bad Bunny x J Balvin');
  assert.equal(splitArtistsForMashup('Bad Bunny x J Balvin'), 'Bad Bunny x J Balvin');
  assert.equal(splitArtistsForMashup('A vs B'), 'A x B');
  assert.equal(splitArtistsForMashup('A feat B'), 'A x B');
  assert.equal(splitArtistsForMashup('A ft. B'), 'A x B');
});

test('splitArtistsForMashup: singolo artista passa attraverso', () => {
  assert.equal(splitArtistsForMashup('Bad Bunny'), 'Bad Bunny');
});

// ── formatBpm (legacy) ───────────────────────────────────────────

test('formatBpm: formato " (BPM)" o vuoto', () => {
  assert.equal(formatBpm({ bpm: 98 }), ' (98)');
  assert.equal(formatBpm({ bpm: 120.7 }), ' (121)');  // rounded
  assert.equal(formatBpm({ bpm: 0 }), '');
  assert.equal(formatBpm({ bpm: null }), '');
  assert.equal(formatBpm({}), '');
});

// ── generateNewFileName: casi end-to-end ────────────────────────

test('generateNewFileName: mix riconosciuto → nome unico con artisti', () => {
  const track = {
    fileName: 'mix-ago-2025.mp3',
    type: 'mix',
    isMix: true,
    duration: 3600,
    // Entrambi confidence ≥ 80 (MIN_SEG_CONFIDENCE = CONFIG.recognition.minConfidence)
    mixSegments: [
      { artist: 'Bad Bunny', title: 'Titi', bpm: 94, confidence: 85 },
      { artist: 'J Balvin',  title: 'Mi Gente', bpm: 94, confidence: 90 },
    ],
  };
  const r = generateNewFileName(track);
  assert.equal(r.strategy, 'mix_segments');
  assert.ok(r.canRename);
  assert.ok(r.newFileName.includes('Bad Bunny'), `atteso "Bad Bunny" in "${r.newFileName}"`);
  assert.ok(r.newFileName.includes('J Balvin'), `atteso "J Balvin" in "${r.newFileName}"`);
  assert.match(r.newFileName, /\.mp3$/);
});

test('generateNewFileName: recognized singolo con BPM + key', () => {
  const track = {
    fileName: 'track.mp3',
    isRecognized: true,
    recognizedTitle: 'Titi Me Pregunto',
    recognizedArtist: 'Bad Bunny',
    recognitionConfidence: 90,
    bpm: 94,
    key: '11A',
  };
  const r = generateNewFileName(track);
  assert.equal(r.strategy, 'recognized');
  assert.ok(r.canRename);
  assert.equal(r.newFileName, 'Bad Bunny - Titi Me Pregunto (94 11A).mp3');
});

test('generateNewFileName: mashup con aiGenre → [Afro House Edit]', () => {
  const track = {
    fileName: 'track.mp3',
    isRecognized: true,
    recognizedTitle: 'Yo Perreo Sola',
    recognizedArtist: 'Bad Bunny',
    localTitle: 'Yo Perreo Sola (Afro Edit)',
    isMashup: true,
    aiGenre: 'afrohouse',
    bpm: 118,
    key: '3A',
  };
  const r = generateNewFileName(track);
  assert.equal(r.strategy, 'recognized');
  assert.match(r.newFileName, /\[Afro House Edit\]/);
  assert.match(r.newFileName, /\(118 3A\)\.mp3$/);
});

test('generateNewFileName: mashup multi-artista con aiGenre → [Tech House Mashup]', () => {
  const track = {
    fileName: 'track.mp3',
    isRecognized: true,
    recognizedTitle: 'Mashup',
    recognizedArtist: 'Bad Bunny x Sfera',
    isMashup: true,
    aiGenre: 'techhouse',
    bpm: 126,
    key: '8A',
  };
  const r = generateNewFileName(track);
  assert.match(r.newFileName, /\[Tech House Mashup\]/);
});

test('generateNewFileName: fallback CHECK_ senza info utili', () => {
  const track = { fileName: 'untitled_track.mp3', filePath: '/x/untitled_track.mp3' };
  const r = generateNewFileName(track);
  assert.equal(r.strategy, 'check_prefix');
  assert.ok(!r.canRename);
  assert.match(r.newFileName, /^_CHECK_/);
});
