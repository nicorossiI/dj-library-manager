/**
 * tests/rekordboxXml.test.js
 *
 * Test per il round-trip dell'XML Rekordbox:
 *  - parse via xml2js
 *  - update con nuove tracce
 *  - riserializzazione con BOM UTF-8
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseRekordboxXml,
  updateRekordboxXml,
} = require('../src/services/libraryUpdateService');

// ─── Fixture helpers ────────────────────────────────────────────

function writeSampleXml() {
  const xml = '\uFEFF<?xml version="1.0" encoding="UTF-8"?>'
    + '<DJ_PLAYLISTS Version="1.0.0">'
    + '<PRODUCT Name="DJLM" Version="1.0.0" Company="DJLM"/>'
    + '<COLLECTION Entries="1">'
    + '<TRACK TrackID="1" Name="Test A" Artist="Artist A" Genre="afrohouse" '
    + 'Location="file://localhost/x/test_a.mp3" AverageBpm="120.00" '
    + 'TotalTime="200" Kind="MP3 File"/>'
    + '</COLLECTION>'
    + '<PLAYLISTS>'
    + '<NODE Type="0" Name="ROOT" Count="1">'
    + '<NODE Type="1" Name="Afro House" Entries="1" KeyType="0">'
    + '<TRACK Key="1"/>'
    + '</NODE>'
    + '</NODE>'
    + '</PLAYLISTS>'
    + '</DJ_PLAYLISTS>';
  const tmp = path.join(os.tmpdir(), `djlm-xml-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
  fs.writeFileSync(tmp, xml, 'utf8');
  return tmp;
}

// ─── Tests ──────────────────────────────────────────────────────

test('parseRekordboxXml: legge struttura base senza BOM', async () => {
  const tmp = writeSampleXml();
  try {
    const doc = await parseRekordboxXml(tmp);
    assert.ok(doc.DJ_PLAYLISTS, 'DJ_PLAYLISTS root presente');
    const col = doc.DJ_PLAYLISTS.COLLECTION[0];
    assert.equal(col.$.Entries, '1');
    assert.equal(col.TRACK.length, 1);
    assert.equal(col.TRACK[0].$.TrackID, '1');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('updateRekordboxXml: appende nuova track e aggiorna contatori', async () => {
  const tmp = writeSampleXml();
  try {
    const newTrack = {
      id: 'hash-xyz',
      filePath: 'Z:\\src\\test_b.mp3',
      newFilePath: 'Z:\\dst\\test_b.mp3',
      fileName: 'test_b.mp3',
      recognizedTitle: 'Test B',
      recognizedArtist: 'Artist B',
      aiGenre: 'afrohouse',
      targetFolder: 'Afro House',
      bpm: 120,
      duration: 200,
      format: 'mp3',
    };

    const result = await updateRekordboxXml(tmp, [newTrack]);
    assert.equal(result.added, 1);

    // Rileggi e verifica
    const doc = await parseRekordboxXml(tmp);
    const col = doc.DJ_PLAYLISTS.COLLECTION[0];
    assert.equal(col.$.Entries, '2', 'COLLECTION Entries incrementato');
    assert.equal(col.TRACK.length, 2);
    assert.equal(col.TRACK[1].$.TrackID, '2');
    assert.equal(col.TRACK[1].$.Artist, 'Artist B');

    // Playlist "Afro House" dovrebbe avere 2 entries ora
    const root = doc.DJ_PLAYLISTS.PLAYLISTS[0].NODE[0];
    const afroNode = root.NODE.find(n => n.$.Name === 'Afro House');
    assert.ok(afroNode, 'playlist Afro House presente');
    assert.equal(afroNode.$.Entries, '2');
    assert.equal(afroNode.TRACK.length, 2);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('updateRekordboxXml: crea playlist mancante se targetFolder nuovo', async () => {
  const tmp = writeSampleXml();
  try {
    const newTrack = {
      id: 'hash-xyz',
      filePath: 'Z:\\src\\techno.mp3',
      newFilePath: 'Z:\\dst\\techno.mp3',
      fileName: 'techno.mp3',
      recognizedTitle: 'Techno Track',
      recognizedArtist: 'DJ X',
      aiGenre: 'techno',
      targetFolder: 'Techno',
      bpm: 132,
      duration: 300,
    };

    await updateRekordboxXml(tmp, [newTrack]);

    const doc = await parseRekordboxXml(tmp);
    const root = doc.DJ_PLAYLISTS.PLAYLISTS[0].NODE[0];
    const technoNode = root.NODE.find(n => n.$.Name === 'Techno');
    assert.ok(technoNode, 'playlist Techno creata');
    assert.equal(technoNode.$.Entries, '1');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('updateRekordboxXml: newTracks vuoto → no-op', async () => {
  const tmp = writeSampleXml();
  try {
    const result = await updateRekordboxXml(tmp, []);
    assert.equal(result.added, 0);
  } finally {
    fs.unlinkSync(tmp);
  }
});
