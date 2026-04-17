/**
 * scripts/downloadModels.js
 *
 * Scarica i modelli essentia.js (DiscogsEffNet) in assets/models/
 * Idempotente: file già presenti vengono skippati.
 *
 * Uso: node scripts/downloadModels.js
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, '..', 'assets', 'models');
if (!fs.existsSync(MODELS_DIR)) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
}

const FILES = [
  {
    name: 'discogs-effnet-bs64-1.pb',
    url: 'https://essentia.upf.edu/models/music-style-classification/discogs-effnet/discogs-effnet-bs64-1.pb',
  },
  {
    name: 'discogs-effnet-bs64-1.json',
    url: 'https://essentia.upf.edu/models/music-style-classification/discogs-effnet/discogs-effnet-bs64-1.json',
  },
];

function download(url, dest) {
  if (fs.existsSync(dest)) {
    const size = fs.statSync(dest).size;
    console.log(`✓ già presente: ${path.basename(dest)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    return Promise.resolve();
  }
  console.log(`→ Scarico: ${path.basename(dest)}`);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => {
      https.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          return reject(new Error(`HTTP ${res.statusCode} su ${u}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          const size = fs.statSync(dest).size;
          console.log(`✓ scaricato: ${path.basename(dest)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };
    get(url);
  });
}

(async () => {
  try {
    for (const f of FILES) {
      await download(f.url, path.join(MODELS_DIR, f.name));
    }
    console.log('\n✅ Modelli pronti in assets/models/');
  } catch (err) {
    console.error('\n❌ Errore download:', err.message);
    process.exit(1);
  }
})();
