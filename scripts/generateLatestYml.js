/**
 * scripts/generateLatestYml.js
 *
 * electron-builder con target `portable` NON genera `latest.yml`, che è
 * invece richiesto da electron-updater per il check aggiornamenti.
 * Questo script lo produce a partire dal .exe appena buildato:
 *   - version  → letta da package.json
 *   - sha512   → calcolato dal binario, base64-encoded (formato nodejs)
 *   - size     → byte del .exe
 *
 * Run: node scripts/generateLatestYml.js
 * Prereq: build portable completata.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml'); // electron-builder lo installa già

const pkg = require('../package.json');

function readOutputDir() {
  // electron-builder.yml → directories.output
  const cfgPath = path.join(__dirname, '..', 'electron-builder.yml');
  const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8'));
  return cfg?.directories?.output || path.join(__dirname, '..', 'dist');
}

function sha512Base64(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha512').update(buf).digest('base64');
}

function main() {
  const outputDir = readOutputDir();
  const exeName = 'DJ_Library_Manager.exe';
  const exePath = path.join(outputDir, exeName);

  if (!fs.existsSync(exePath)) {
    console.error(`[latest.yml] .exe non trovato: ${exePath}`);
    process.exit(1);
  }

  const size = fs.statSync(exePath).size;
  const sha = sha512Base64(exePath);
  const releaseDate = new Date().toISOString();

  const latest = {
    version: pkg.version,
    files: [{ url: exeName, sha512: sha, size }],
    path: exeName,
    sha512: sha,
    releaseDate,
  };

  const ymlPath = path.join(outputDir, 'latest.yml');
  fs.writeFileSync(ymlPath, yaml.dump(latest, { lineWidth: 200 }), 'utf8');
  console.log(`[latest.yml] Generato: ${ymlPath}`);
  console.log(`  version: ${pkg.version}`);
  console.log(`  size:    ${size.toLocaleString()} bytes`);
  console.log(`  sha512:  ${sha.slice(0, 20)}...`);
}

main();
