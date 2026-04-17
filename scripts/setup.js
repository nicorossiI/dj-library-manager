/**
 * scripts/setup.js
 *
 * Setup one-shot: l'utente clona il repo, fa `npm install`, e TUTTO è pronto.
 *
 * Azioni in sequenza (tutte idempotenti):
 *   1. Verifica Node.js
 *   2. npm install              (skip se node_modules esiste o se in postinstall)
 *   3. Scarica fpcalc.exe       (skip se assets/bin/fpcalc.exe esiste)
 *   3b. Scarica keyfinder-cli   (skip se assets/bin/keyfinder-cli.exe esiste, solo Windows)
 *   4. Crea icon.ico            (skip se assets/icon.ico esiste e ha dimensione > 0)
 *   5. Crea .env                (skip se .env esiste)
 *
 * Si può lanciare con:
 *   npm install             → npm esegue postinstall → setup.js gira
 *   npm run setup           → esecuzione esplicita
 *
 * Zero dep npm extra: usa solo https, fs, path, child_process, Buffer nativi.
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync, spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const ASSETS_DIR = path.join(ROOT, 'assets');
const ASSETS_BIN = path.join(ASSETS_DIR, 'bin');
const FPCALC_PATH = path.join(ASSETS_BIN, 'fpcalc.exe');
const KEYFINDER_CLI_PATH = path.join(ASSETS_BIN, 'keyfinder-cli.exe');
const ICON_PATH = path.join(ASSETS_DIR, 'icon.ico');
const ENV_PATH = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

const IS_POSTINSTALL = process.env.npm_lifecycle_event === 'postinstall';
const USER_AGENT = 'dj-library-manager-setup';

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

const ok   = (msg) => console.log(`✓ ${msg}`);
const info = (msg) => console.log(`→ ${msg}`);
const warn = (msg) => console.warn(`⚠️  ${msg}`);
const err  = (msg) => console.error(`✗ ${msg}`);
const hr   = () => console.log('─'.repeat(60));

// ---------------------------------------------------------------------------
// Step 1: Verify Node.js
// ---------------------------------------------------------------------------

function step1_verifyNode() {
  try {
    const v = execSync('node --version', { encoding: 'utf8' }).trim();
    ok(`Node.js rilevato: ${v}`);
  } catch {
    err('Node.js non trovato nel PATH.');
    err('Installalo da https://nodejs.org/ (consigliato LTS >= 18)');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Step 2: npm install (skip se postinstall o se node_modules esiste)
// ---------------------------------------------------------------------------

function step2_npmInstall() {
  if (IS_POSTINSTALL) {
    info('Postinstall hook attivo — npm install già in corso, skip');
    return;
  }
  if (fs.existsSync(NODE_MODULES)) {
    info('node_modules/ esistente — skip npm install');
    return;
  }
  info('Installo dipendenze (npm install)...');
  try {
    execSync('npm install', { stdio: 'inherit', cwd: ROOT });
    ok('Dipendenze installate');
  } catch (e) {
    err(`npm install fallito: ${e.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Step 3: Download fpcalc.exe (Chromaprint)
// ---------------------------------------------------------------------------

function httpsGet(url, { headers = {}, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error('Troppi redirect'));
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpsGet(next, { headers, maxRedirects: maxRedirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} su ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => { req.destroy(new Error('download timeout')); });
  });
}

function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...opts, windowsHide: true });
    let stderr = '';
    if (proc.stderr) proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

async function extractZip(zipPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  try {
    // Windows 10 1803+ ha tar.exe built-in, supporta zip
    await spawnAsync('tar', ['-xf', zipPath, '-C', destDir]);
    return;
  } catch {
    // Fallback: PowerShell Expand-Archive
    await spawnAsync('powershell', [
      '-NoProfile', '-NonInteractive',
      '-Command',
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
    ]);
  }
}

async function findFpcalcExe(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === 'fpcalc.exe') return full;
    if (e.isDirectory()) {
      const nested = await findFpcalcExe(full);
      if (nested) return nested;
    }
  }
  return null;
}

async function findExeByName(dir, exeName) {
  const needle = String(exeName).toLowerCase();
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === needle) return full;
    if (e.isDirectory()) {
      const nested = await findExeByName(full, exeName);
      if (nested) return nested;
    }
  }
  return null;
}

async function step3_downloadFpcalc() {
  if (fs.existsSync(FPCALC_PATH)) {
    const stat = await fsp.stat(FPCALC_PATH);
    if (stat.size > 1024) {
      info(`fpcalc.exe già presente (${(stat.size / 1024).toFixed(0)} KB) — skip download`);
      return;
    }
  }

  await fsp.mkdir(ASSETS_BIN, { recursive: true });

  try {
    info('Cerco latest release di chromaprint...');
    const apiUrl = 'https://api.github.com/repos/acoustid/chromaprint/releases/latest';
    const jsonBuf = await httpsGet(apiUrl, { headers: { Accept: 'application/vnd.github+json' } });
    const info_ = JSON.parse(jsonBuf.toString('utf8'));

    const asset = (info_.assets || []).find(a =>
      /windows.*x86_64/i.test(a.name) && /\.zip$/i.test(a.name),
    ) || (info_.assets || []).find(a => /windows/i.test(a.name) && /\.zip$/i.test(a.name));

    if (!asset) throw new Error('Asset Windows ZIP non trovato nella release latest');

    info(`Scarico ${asset.name} (${(asset.size / 1024).toFixed(0)} KB, chromaprint ${info_.tag_name})...`);
    const zipBuf = await httpsGet(asset.browser_download_url);

    const tmpZip = path.join(os.tmpdir(), `chromaprint-${Date.now()}.zip`);
    const tmpExtract = path.join(os.tmpdir(), `chromaprint-extract-${Date.now()}`);
    await fsp.writeFile(tmpZip, zipBuf);

    info('Estraggo archivio...');
    await extractZip(tmpZip, tmpExtract);

    const fpcalcSrc = await findFpcalcExe(tmpExtract);
    if (!fpcalcSrc) throw new Error('fpcalc.exe non trovato nell\'archivio');

    await fsp.copyFile(fpcalcSrc, FPCALC_PATH);
    ok(`fpcalc.exe installato in assets/bin/ (chromaprint ${info_.tag_name})`);

    // Cleanup
    await fsp.rm(tmpZip, { force: true }).catch(() => {});
    await fsp.rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
  } catch (e) {
    warn(`Download fpcalc.exe fallito: ${e.message}`);
    warn('Puoi scaricarlo manualmente:');
    warn('  1. Vai su https://github.com/acoustid/chromaprint/releases/latest');
    warn('  2. Scarica chromaprint-fpcalc-*-windows-x86_64.zip');
    warn(`  3. Estrai fpcalc.exe in: ${FPCALC_PATH}`);
    warn('L\'app funzionerà comunque, ma senza fingerprint acustico locale.');
  }
}

// ---------------------------------------------------------------------------
// Step 3b: Download keyfinder-cli.exe (libkeyfinder, stessa lib di Mixxx)
// ---------------------------------------------------------------------------

async function step3b_downloadKeyfinderCli() {
  if (process.platform !== 'win32') {
    info('keyfinder-cli: download automatico solo su Windows — skip');
    return;
  }
  if (fs.existsSync(KEYFINDER_CLI_PATH)) {
    const stat = await fsp.stat(KEYFINDER_CLI_PATH);
    if (stat.size > 1024) {
      info(`keyfinder-cli.exe già presente (${(stat.size / 1024).toFixed(0)} KB) — skip download`);
      return;
    }
  }
  await fsp.mkdir(ASSETS_BIN, { recursive: true });

  try {
    info('Cerco latest release di keyfinder-cli...');
    const apiUrl = 'https://api.github.com/repos/evanpurkhiser/keyfinder-cli/releases/latest';
    const jsonBuf = await httpsGet(apiUrl, { headers: { Accept: 'application/vnd.github+json' } });
    const info_ = JSON.parse(jsonBuf.toString('utf8'));

    const asset = (info_.assets || []).find(a =>
      /windows.*x86_64|win.*64|win64/i.test(a.name) && /\.(zip|7z)$/i.test(a.name)
    ) || (info_.assets || []).find(a =>
      /windows/i.test(a.name) && /\.zip$/i.test(a.name)
    );

    if (!asset) throw new Error('Asset Windows non trovato nella release latest di keyfinder-cli');

    info(`Scarico ${asset.name} (${(asset.size / 1024).toFixed(0)} KB, keyfinder-cli ${info_.tag_name})...`);
    const zipBuf = await httpsGet(asset.browser_download_url);

    const tmpZip = path.join(os.tmpdir(), `keyfinder-cli-${Date.now()}${path.extname(asset.name)}`);
    const tmpExtract = path.join(os.tmpdir(), `keyfinder-cli-extract-${Date.now()}`);
    await fsp.writeFile(tmpZip, zipBuf);

    info('Estraggo archivio...');
    await extractZip(tmpZip, tmpExtract);

    const exeSrc = await findExeByName(tmpExtract, 'keyfinder-cli.exe');
    if (!exeSrc) throw new Error('keyfinder-cli.exe non trovato nell\'archivio');

    await fsp.copyFile(exeSrc, KEYFINDER_CLI_PATH);
    ok(`keyfinder-cli.exe installato in assets/bin/ (${info_.tag_name})`);

    // Cleanup
    await fsp.rm(tmpZip, { force: true }).catch(() => {});
    await fsp.rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
  } catch (e) {
    warn(`Download keyfinder-cli fallito: ${e.message}`);
    warn('Puoi scaricarlo manualmente:');
    warn('  1. Vai su https://github.com/evanpurkhiser/keyfinder-cli/releases/latest');
    warn('  2. Scarica l\'asset Windows (keyfinder-cli-*-windows-x86_64.zip o simile)');
    warn(`  3. Estrai keyfinder-cli.exe in: ${KEYFINDER_CLI_PATH}`);
    warn('Key detection funzionerà comunque via essentia.js come fallback.');
  }
}

// ---------------------------------------------------------------------------
// Step 4: icon.ico placeholder (32-bit BGRA, 16x16, rosso brand #e94560)
// ---------------------------------------------------------------------------

/**
 * Costruisce un .ico 16x16 valido minimo con un quadrato rosso brand.
 * Formato: ICO header + directory entry + BITMAPINFOHEADER + XOR mask + AND mask.
 */
function buildPlaceholderIcoBuffer() {
  // electron-builder richiede minimo 256x256. Generiamo un ICO con
  // DUE immagini: 256x256 (richiesta) + 16x16 (compat tray/taskbar Windows).
  // Brand red #e94560 con angoli arrotondati (soft square).
  function makeImage(size) {
    const pixelDataSize = size * size * 4;          // BGRA
    const andMaskSize = Math.ceil((size * size) / 8);
    const dibHeaderSize = 40;
    const imageSize = dibHeaderSize + pixelDataSize + andMaskSize;

    const dib = Buffer.alloc(40);
    dib.writeUInt32LE(40, 0);           // biSize
    dib.writeInt32LE(size, 4);          // biWidth
    dib.writeInt32LE(size * 2, 8);      // biHeight (2x per XOR+AND masks)
    dib.writeUInt16LE(1, 12);           // biPlanes
    dib.writeUInt16LE(32, 14);          // biBitCount
    dib.writeUInt32LE(0, 16);           // biCompression (BI_RGB)
    dib.writeUInt32LE(pixelDataSize, 20);

    // Pixel data: BGRA, rosso brand con corner-rounding morbido.
    // ICO store row bottom-up; qui non importa (simmetrico).
    const pixels = Buffer.alloc(pixelDataSize);
    const radius = Math.floor(size * 0.22);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        // Corner rounding: distanza dal corner più vicino (approx)
        const dx = Math.min(x, size - 1 - x);
        const dy = Math.min(y, size - 1 - y);
        const inCorner = dx < radius && dy < radius &&
          Math.hypot(radius - dx, radius - dy) > radius;
        if (inCorner) {
          // Trasparente
          pixels[idx] = 0; pixels[idx + 1] = 0; pixels[idx + 2] = 0; pixels[idx + 3] = 0;
        } else {
          pixels[idx]     = 96;    // B
          pixels[idx + 1] = 69;    // G
          pixels[idx + 2] = 233;   // R
          pixels[idx + 3] = 255;   // A
        }
      }
    }
    const andMask = Buffer.alloc(andMaskSize, 0);
    return { imageSize, dib, pixels, andMask, size };
  }

  const img256 = makeImage(256);
  const img16 = makeImage(16);

  // ICO header (6 bytes) — 2 immagini
  const icoHeader = Buffer.alloc(6);
  icoHeader.writeUInt16LE(0, 0);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(2, 4);   // count = 2

  // Directory entries (16 bytes ciascuna)
  const headerSize = 6 + 16 * 2;   // 38
  function dirEntry(img, offset) {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size === 256 ? 0 : img.size, 0);     // 0 = 256
    e.writeUInt8(img.size === 256 ? 0 : img.size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.imageSize, 8);
    e.writeUInt32LE(offset, 12);
    return e;
  }

  const entry256 = dirEntry(img256, headerSize);
  const entry16 = dirEntry(img16, headerSize + img256.imageSize);

  return Buffer.concat([
    icoHeader, entry256, entry16,
    img256.dib, img256.pixels, img256.andMask,
    img16.dib, img16.pixels, img16.andMask,
  ]);
}

async function step4_ensureIcon() {
  if (fs.existsSync(ICON_PATH)) {
    const stat = await fsp.stat(ICON_PATH);
    if (stat.size > 0) {
      info(`icon.ico già presente (${stat.size} bytes) — skip`);
      return;
    }
  }
  await fsp.mkdir(ASSETS_DIR, { recursive: true });
  const buf = buildPlaceholderIcoBuffer();
  await fsp.writeFile(ICON_PATH, buf);
  ok(`icon.ico placeholder creato (${buf.length} bytes, quadrato rosso 16x16)`);
}

// ---------------------------------------------------------------------------
// Step 5: .env bootstrap
// ---------------------------------------------------------------------------

async function step5_ensureEnv() {
  if (fs.existsSync(ENV_PATH)) {
    info('.env già presente — skip');
    return;
  }
  if (!fs.existsSync(ENV_EXAMPLE)) {
    warn('.env.example non trovato, skip creazione .env');
    return;
  }
  await fsp.copyFile(ENV_EXAMPLE, ENV_PATH);
  ok('.env creato da .env.example (compila le chiavi ACRCloud quando vuoi)');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  hr();
  console.log('DJ Library Manager — Setup automatico');
  hr();

  step1_verifyNode();
  step2_npmInstall();
  await step3_downloadFpcalc();
  await step3b_downloadKeyfinderCli();
  await step4_ensureIcon();
  await step5_ensureEnv();

  hr();
  console.log('✅ Setup completato!');
  console.log('');
  console.log('  → Esegui:  npm start');
  console.log('  → Poi carica i tuoi MP3 nell\'app per testare');
  console.log('');
  hr();
}

main().catch((e) => {
  err(`Setup fallito: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
