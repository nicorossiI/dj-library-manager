/**
 * tests/duplicates.test.js
 *
 * Test per il sistema doppioni sicuro:
 *  - findDuplicates con multi-prefix fingerprint
 *  - requiresManualReview flag su text match e acoustic_similar
 *  - fingerprintConfidence popolato in DuplicateItem
 *  - ranking recommended con formato/bitrate
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findDuplicates } = require('../src/services/duplicateService');
const { DuplicateGroup, DuplicateItem } = require('../src/models/DuplicateGroup');

// Fingerprint stub: stringhe Chromaprint plausibili per il prefix matching
const FP_A = 'AQADtEmYJBSSxCnhBkmpQE3Q47mO5Dx4'; // primi 16/24/32 char stabili
const FP_A_VAR = 'AQADtEmYJBSSxCnhBkmpQE3Q12ab98cd'; // stessi 16, ultimi 16 diversi
const FP_B = 'AQADZaHXKjGlL6NQDFNxTuVvWwXyYzAb'; // completamente diverso

function track(overrides = {}) {
  return {
    id: overrides.id || `id-${Math.random()}`,
    filePath: overrides.filePath || `/x/${overrides.id || 'x'}.mp3`,
    fileName: overrides.fileName || 'track.mp3',
    fileSize: overrides.fileSize ?? 5_000_000,
    duration: overrides.duration ?? 180,
    format: overrides.format || 'mp3',
    bitrate: overrides.bitrate ?? 320,
    fingerprint: overrides.fingerprint ?? FP_A,
    localTitle: overrides.localTitle ?? '',
    localArtist: overrides.localArtist ?? '',
    recognizedTitle: overrides.recognizedTitle ?? '',
    recognizedArtist: overrides.recognizedArtist ?? '',
    isRecognized: overrides.isRecognized ?? false,
    recognitionConfidence: overrides.recognitionConfidence ?? 0,
    ...overrides,
  };
}

// ── ACRCloud exact match ────────────────────────────────────────────

test('findDuplicates: ACR exact match produce acoustic_exact NON review', () => {
  const tracks = [
    track({ id: 'a', isRecognized: true, recognizedArtist: 'Bad Bunny', recognizedTitle: 'Titi' }),
    track({ id: 'b', isRecognized: true, recognizedArtist: 'Bad Bunny', recognizedTitle: 'Titi' }),
  ];
  const groups = findDuplicates(tracks);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matchType, 'acoustic_exact');
  assert.equal(groups[0].similarityScore, 1);
  assert.equal(groups[0].requiresManualReview, false, 'ACR exact NON richiede revisione');
});

// ── Multi-prefix fingerprint bucket ──────────────────────────────────

test('findDuplicates: multi-prefix cattura file con fingerprint simile', () => {
  // Due track con fingerprint che condividono i primi 16 char ma divergono
  // dal char 17 in poi — il vecchio bucket a 24 char li avrebbe persi.
  const tracks = [
    track({
      id: 'a',
      filePath: '/a/song.mp3',
      fingerprint: FP_A,
      localTitle: 'Despacito',
      localArtist: 'Luis Fonsi',
    }),
    track({
      id: 'b',
      filePath: '/b/song.mp3',
      fingerprint: FP_A_VAR,
      localTitle: 'Despacito',
      localArtist: 'Luis Fonsi',
    }),
  ];
  const groups = findDuplicates(tracks);
  assert.ok(groups.length >= 1, 'dovrebbe trovare il duplicato');
  assert.ok(['acoustic_exact', 'acoustic_similar'].includes(groups[0].matchType));
});

// ── Text match → requiresManualReview ────────────────────────────────

test('findDuplicates: text match senza fingerprint richiede revisione', () => {
  const tracks = [
    track({
      id: 'a',
      fingerprint: null,
      localTitle: 'Despacito',
      localArtist: 'Luis Fonsi',
    }),
    track({
      id: 'b',
      fingerprint: null,
      localTitle: 'Despacito',
      localArtist: 'Luis Fonsi',
    }),
  ];
  const groups = findDuplicates(tracks);
  assert.ok(groups.length >= 1);
  assert.equal(groups[0].matchType, 'text_match');
  assert.equal(
    groups[0].requiresManualReview,
    true,
    'text_match DEVE richiedere revisione manuale',
  );
});

// ── Nessun falso positivo su track diverse ───────────────────────────

test('findDuplicates: track con fingerprint diverso + title diverso → no match', () => {
  const tracks = [
    track({ id: 'a', fingerprint: FP_A, localTitle: 'Despacito', localArtist: 'Luis Fonsi' }),
    track({ id: 'b', fingerprint: FP_B, localTitle: 'Mi Gente',  localArtist: 'J Balvin' }),
  ];
  const groups = findDuplicates(tracks);
  assert.equal(groups.length, 0, 'non devono essere duplicati');
});

// ── fingerprintConfidence popolato ───────────────────────────────────

test('DuplicateItem: fingerprintConfidence viene popolato da ACR o fingerprint', () => {
  const tracks = [
    track({ id: 'a', recognitionConfidence: 95, isRecognized: true,
            recognizedTitle: 'X', recognizedArtist: 'Y' }),
    track({ id: 'b', recognitionConfidence: 95, isRecognized: true,
            recognizedTitle: 'X', recognizedArtist: 'Y' }),
  ];
  const groups = findDuplicates(tracks);
  assert.equal(groups.length, 1);
  assert.ok(groups[0].items[0].fingerprintConfidence > 0,
    `fingerprintConfidence dovrebbe essere > 0, è ${groups[0].items[0].fingerprintConfidence}`);
});

// ── DuplicateGroup: refreshRecommended sceglie FLAC > MP3 ────────────

test('DuplicateGroup: FLAC batte MP3 nel ranking recommended', () => {
  const g = new DuplicateGroup({
    matchType: 'acoustic_exact',
    similarityScore: 1,
    items: [
      new DuplicateItem({ trackId: 'mp3', filePath: '/a.mp3', format: 'mp3', bitrate: 320 }),
      new DuplicateItem({ trackId: 'flac', filePath: '/a.flac', format: 'flac', bitrate: 1411 }),
    ],
  });
  const keeper = g.items.find(i => i.recommended);
  assert.equal(keeper.format, 'flac');
});

test('DuplicateGroup: bitrate banded — 320 batte 128 a parità di formato', () => {
  const g = new DuplicateGroup({
    matchType: 'acoustic_exact',
    items: [
      new DuplicateItem({ trackId: 'low',  filePath: '/a.mp3', format: 'mp3', bitrate: 128 }),
      new DuplicateItem({ trackId: 'high', filePath: '/b.mp3', format: 'mp3', bitrate: 320 }),
    ],
  });
  const keeper = g.items.find(i => i.recommended);
  assert.equal(keeper.trackId, 'high');
});

// ── requiresManualReview: exact fingerprint NO, similar SÌ ───────────

test('findDuplicates: fingerprint identico su 64 char → acoustic_exact (no review)', () => {
  const fpLong = 'AQADtEmYJBSSxCnhBkmpQE3Q7nO5Dx4qRsTuVwXyZabCdEfGhIjKlMnOpQrStUvW';
  // entrambi con lo stesso fingerprint e metadati
  const tracks = [
    track({ id: 'a', fingerprint: fpLong, localTitle: 'X', localArtist: 'Y' }),
    track({ id: 'b', fingerprint: fpLong, localTitle: 'X', localArtist: 'Y' }),
  ];
  const groups = findDuplicates(tracks);
  const g = groups[0];
  assert.equal(g.matchType, 'acoustic_exact');
  assert.equal(g.requiresManualReview, false);
});
