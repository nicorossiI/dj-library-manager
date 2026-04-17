/**
 * src/services/ffmpegService.js
 *
 * Wrapper fluent-ffmpeg con binary fornito da ffmpeg-static.
 * Usato per estrarre segmenti di un mix (per riconoscimento ACRCloud)
 * e per conversioni rapide.
 *
 * Esporta: extractSegment, getDuration
 * Dipendenze: fluent-ffmpeg, ffmpeg-static
 */

'use strict';

const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
let ffmpegStatic = require('ffmpeg-static');

// Quando packaged con asarUnpack, il path viene aggiustato automaticamente
// sostituendo "app.asar" con "app.asar.unpacked". ffmpeg-static ritorna una
// stringa, rimpiazziamo se necessario.
if (typeof ffmpegStatic === 'string' && ffmpegStatic.includes('app.asar')) {
  ffmpegStatic = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
}
if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);

function extractSegment(filePath, startSec, durationSec, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .setStartTime(startSec)
      .duration(durationSec)
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .format('mp3')
      .on('error', reject)
      .on('end', () => resolve(outPath))
      .save(outPath);
  });
}

function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data?.format?.duration || 0);
    });
  });
}

module.exports = { extractSegment, getDuration };
