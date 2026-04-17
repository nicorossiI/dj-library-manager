'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateRekordboxXml } = require('../src/services/rekordboxExportService');

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djlm-rb-'));
  const outputRoot = tmpRoot;
  const trackFolder = path.join(outputRoot, 'Afro House Spagnolo', 'Singoli');
  fs.mkdirSync(trackFolder, { recursive: true });
  const trackFile = path.join(trackFolder, 'Bad Bunny - Titi (98 11A).mp3');
  fs.writeFileSync(trackFile, '');

  const tracks = [{
    id: 't1',
    filePath: trackFile,
    newFilePath: trackFile,
    fileName: 'Bad Bunny - Titi (98 11A).mp3',
    format: 'mp3',
    duration: 180,
    bpm: 98,
    key: '11A',
    fileSize: 0,
    bitrate: 320,
    sampleRate: 44100,
    recognizedTitle: 'Titi Me Pregunto',
    recognizedArtist: 'Bad Bunny',
    detectedGenre: 'afrohouse',
    vocalsLanguage: 'es',
    rekordboxPlaylistFolder: 'Afro House Spagnolo',
    rekordboxPlaylistName: 'Singoli',
  }];

  const xmlPath = await generateRekordboxXml(tracks, outputRoot);
  const xml = fs.readFileSync(xmlPath, 'utf8');

  const checks = {
    'Ha BOM': xml.startsWith('\uFEFF'),
    'Path relativo': /Location="Afro%20House%20Spagnolo\/Singoli\/[^"]+"/.test(xml),
    'NO drive letter': !/Location="[A-Za-z]:/.test(xml) && !/Location="file:\/\/localhost\/[A-Za-z]:/.test(xml),
    'NO file://localhost': !xml.includes('file://localhost'),
    'XML declaration': xml.includes('<?xml version="1.0" encoding="UTF-8"?>'),
    'DJ_PLAYLISTS Version': xml.includes('<DJ_PLAYLISTS Version="1.0.0">'),
  };

  let allOk = true;
  for (const [name, ok] of Object.entries(checks)) {
    console.log(`${ok ? '\u2705' : '\u274C'} ${name}`);
    if (!ok) allOk = false;
  }

  const locMatch = xml.match(/Location="([^"]+)"/);
  console.log('\nLocation value:', locMatch ? locMatch[1] : '(none)');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(allOk ? 0 : 1);
})().catch(e => {
  console.error('\u274C Test error:', e.message);
  console.error(e.stack);
  process.exit(1);
});
