/**
 * tests/folderStructure.test.js
 *
 * Test unitari per resolveFolder — la funzione che decide la cartella finale
 * di ogni track in base al genere della BASE audio.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveFolder, FOLDER_ORDER, ALL_FOLDERS_FLAT, genreLabel } =
  require('../src/constants/FOLDER_STRUCTURE');

test('resolveFolder: singolo reggaeton originale', () => {
  assert.equal(resolveFolder({ classifiedGenre: 'reggaeton', isMashup: false }), 'Reggaeton');
});

test('resolveFolder: edit reggaeton con base afrohouse → Afro House', () => {
  assert.equal(
    resolveFolder({ aiGenre: 'afrohouse', classifiedGenre: 'reggaeton', isMashup: true }),
    'Afro House',
  );
});

test('resolveFolder: aiGenre batte detectedGenre', () => {
  assert.equal(
    resolveFolder({ aiGenre: 'techhouse', detectedGenre: 'reggaeton' }),
    'Tech House',
  );
});

test('resolveFolder: mix lungo → Mix e Set', () => {
  assert.equal(resolveFolder({ fileType: 'mix', duration: 2700 }), 'Mix e Set');
});

test('resolveFolder: type=mix → Mix e Set', () => {
  assert.equal(resolveFolder({ type: 'mix', duration: 120 }), 'Mix e Set');
});

test('resolveFolder: isMix flag → Mix e Set', () => {
  assert.equal(resolveFolder({ isMix: true, duration: 0 }), 'Mix e Set');
});

test('resolveFolder: duration > 480s → Mix e Set anche senza flag', () => {
  assert.equal(resolveFolder({ duration: 600 }), 'Mix e Set');
});

test('resolveFolder: input vuoto → Da Controllare', () => {
  assert.equal(resolveFolder({}), 'Da Controllare');
});

test('resolveFolder: null-safe', () => {
  assert.equal(resolveFolder(null), 'Da Controllare');
  assert.equal(resolveFolder(undefined), 'Da Controllare');
});

test('resolveFolder: status=error → Da Controllare', () => {
  assert.equal(resolveFolder({ aiGenre: 'afrohouse', status: 'error' }), 'Da Controllare');
});

test('resolveFolder: bachata + salsa + tropical tutti → Bachata e Tropicale', () => {
  assert.equal(resolveFolder({ aiGenre: 'bachata' }), 'Bachata e Tropicale');
  assert.equal(resolveFolder({ aiGenre: 'salsa' }), 'Bachata e Tropicale');
  assert.equal(resolveFolder({ aiGenre: 'tropical' }), 'Bachata e Tropicale');
});

test('resolveFolder: hiphop + trap → Hip Hop e Trap', () => {
  assert.equal(resolveFolder({ aiGenre: 'hiphop' }), 'Hip Hop e Trap');
  assert.equal(resolveFolder({ aiGenre: 'trap' }), 'Hip Hop e Trap');
});

test('resolveFolder: genere sconosciuto → Da Controllare', () => {
  assert.equal(resolveFolder({ aiGenre: 'kpop' }), 'Da Controllare');
});

test('resolveFolder: normalizzazione case/spazi', () => {
  assert.equal(resolveFolder({ aiGenre: 'AfroHouse' }), 'Afro House');
  assert.equal(resolveFolder({ aiGenre: 'afro-house' }), 'Afro House');
  assert.equal(resolveFolder({ aiGenre: 'TECH HOUSE' }), 'Tech House');
});

test('FOLDER_ORDER: 11 cartelle nell\'ordine serata', () => {
  assert.equal(FOLDER_ORDER.length, 11);
  assert.equal(FOLDER_ORDER[0], 'Riscaldamento');
  assert.equal(FOLDER_ORDER[FOLDER_ORDER.length - 1], 'Da Controllare');
});

test('ALL_FOLDERS_FLAT: tutti i FOLDER_ORDER sono in ALL_FOLDERS_FLAT', () => {
  for (const name of FOLDER_ORDER) {
    if (name === 'Da Controllare') continue; // fallback, sempre incluso
    assert.ok(
      ALL_FOLDERS_FLAT.has(name),
      `"${name}" dovrebbe essere in ALL_FOLDERS_FLAT`,
    );
  }
});

test('genreLabel: normalizza casing e separatori', () => {
  assert.equal(genreLabel('afrohouse'), 'Afro House');
  assert.equal(genreLabel('AfroHouse'), 'Afro House');
  assert.equal(genreLabel('afro-house'), 'Afro House');
  assert.equal(genreLabel('tech house'), 'Tech House');
  assert.equal(genreLabel(null), '');
  assert.equal(genreLabel(''), '');
  assert.equal(genreLabel('unknown_xxx'), '');
});
