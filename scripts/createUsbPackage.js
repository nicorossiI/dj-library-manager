/**
 * scripts/createUsbPackage.js
 *
 * Post-build: crea dist/USB_PACKAGE/ pronto da copiare su chiavetta USB.
 * Contenuto finale:
 *   dist/USB_PACKAGE/
 *     DJ_Library_Manager.exe          ← dal build portable electron-builder
 *     fpcalc.exe                      ← scaricato da github.com/acoustid/chromaprint
 *     COME_USARE.txt                  ← guida utente generata al volo
 *     config/                         ← cartella vuota (placeholder)
 *
 * Uso:
 *   npm run build:usb
 *   (equivale a: npm run build:portable && node scripts/createUsbPackage.js)
 *
 * Dipendenze: fs, path, https, child_process (spawn tar.exe / PowerShell)
 * Zero dep npm aggiuntive. Funziona su Windows 10+ (tar.exe built-in).
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const USB_DIR = path.join(DIST, 'USB_PACKAGE');
const USB_CONFIG_DIR = path.join(USB_DIR, 'config');
const EXE_NAME = 'DJ_Library_Manager.exe';
const FPCALC_NAME = 'fpcalc.exe';

// ---------------------------------------------------------------------------
// COME_USARE.txt (testo esatto secondo spec)
// ---------------------------------------------------------------------------

const COME_USARE = `═══════════════════════════════════════
DJ LIBRARY MANAGER — Guida rapida
═══════════════════════════════════════

AVVIO:
Doppio click su DJ_Library_Manager.exe
Niente installazione richiesta.

PRIMA DI USARE — API ACRCLOUD (opzionale ma consigliato):
Serve per riconoscere automaticamente il nome delle canzoni.
Piano gratuito: 1000 riconoscimenti/giorno.
1. Vai su: https://console.acrcloud.com/signup
2. Crea un progetto "Audio Recognition"
3. Copia: Host, Access Key, Access Secret
4. Incollali nelle Impostazioni dell'app (icona ⚙️)
Senza API key: l'app funziona lo stesso,
usa i tag ID3 dei file per nome/artista.

USO IN 5 PASSI:
1. Seleziona la cartella con la tua musica
2. Clicca "AVVIA ANALISI COMPLETA" e aspetta
3. Tab DOPPIONI: vedi quali canzoni si ripetono,
   scegli cosa eliminare
4. Tab RINOMINA: rinomina i file automaticamente
5. Tab ORGANIZZA: crea la libreria organizzata
6. Tab REKORDBOX: genera il rekordbox.xml,
   segui le istruzioni per importare in Rekordbox

IMPORTANTE PER REKORDBOX:
- Dopo aver generato rekordbox.xml NON spostare la cartella
  "DJ Library Organizzata" su un'altra lettera di drive
- Se cambia la lettera della USB: rigenera rekordbox.xml
  con l'app (clicca di nuovo "GENERA rekordbox.xml")

PROBLEMI COMUNI:
- "API non funziona": verifica le credenziali in Impostazioni
- "File non riconosciuto": il file userà i tag ID3 esistenti
- "Cartella non creata": verifica di avere permessi di scrittura
- "Rekordbox non vede i file": verifica che il percorso nel xml
  corrisponda a dove si trova fisicamente la USB
═══════════════════════════════════════
`;

// ---------------------------------------------------------------------------
// HTTP helpers (no deps)
// ---------------------------------------------------------------------------

const USER_AGENT = 'dj-library-manager-build';

function httpsGet(url, { headers = {}, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
    }, (res) => {
      // Follow redirects (3xx)
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

// ---------------------------------------------------------------------------
// Chromaprint fetch
// ---------------------------------------------------------------------------

/**
 * Interroga GitHub API per l'ultima release di chromaprint,
 * trova l'asset Windows x86_64 ZIP e lo scarica in memoria.
 */
async function downloadChromaprintZip() {
  const apiUrl = 'https://api.github.com/repos/acoustid/chromaprint/releases/latest';
  console.log('→ Fetch latest chromaprint release info...');
  const jsonBuf = await httpsGet(apiUrl, { headers: { Accept: 'application/vnd.github+json' } });
  const info = JSON.parse(jsonBuf.toString('utf8'));

  const assets = info.assets || [];
  const asset = assets.find(a =>
    /windows.*x86_64/i.test(a.name) && /\.zip$/i.test(a.name),
  ) || assets.find(a => /windows/i.test(a.name) && /\.zip$/i.test(a.name));

  if (!asset) {
    throw new Error(`Nessun asset Windows ZIP trovato nella release ${info.tag_name}. Asset disponibili: ${assets.map(a => a.name).join(', ')}`);
  }
  console.log(`→ Scarico asset: ${asset.name} (${(asset.size / 1024).toFixed(0)} KB)`);
  const zipBuf = await httpsGet(asset.browser_download_url);
  return { zipBuf, assetName: asset.name, releaseTag: info.tag_name };
}

// ---------------------------------------------------------------------------
// ZIP extraction (tar.exe → PowerShell fallback)
// ---------------------------------------------------------------------------

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

  // Prova 1: tar.exe (Windows 10 1803+ lo ha built-in, supporta zip)
  try {
    await spawnAsync('tar', ['-xf', zipPath, '-C', destDir]);
    return;
  } catch (err) {
    console.warn(`  tar.exe fallito (${err.message.slice(0, 80)}), provo PowerShell...`);
  }

  // Prova 2: PowerShell Expand-Archive
  try {
    await spawnAsync('powershell', [
      '-NoProfile', '-NonInteractive',
      '-Command',
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
    ]);
    return;
  } catch (err) {
    throw new Error(
      `Impossibile estrarre ${zipPath}. Né tar.exe né PowerShell funzionano.\n` +
      `Estrai manualmente il file in: ${destDir}\n(${err.message})`,
    );
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(DIST)) {
    console.error('✗ dist/ non trovata. Esegui prima: npm run build:portable');
    process.exit(1);
  }

  // Trova l'exe portable generato da electron-builder
  const exeFiles = (await fsp.readdir(DIST)).filter(f => f.toLowerCase().endsWith('.exe'));
  if (exeFiles.length === 0) {
    console.error('✗ Nessun .exe in dist/. Esegui prima: npm run build:portable');
    process.exit(1);
  }

  const exeSrc = path.join(DIST, exeFiles.find(f => f === EXE_NAME) || exeFiles[0]);
  console.log(`✓ Trovato exe: ${path.basename(exeSrc)}`);

  // Pulisci cartella destinazione se già esiste
  if (fs.existsSync(USB_DIR)) {
    console.log(`→ Rimuovo USB_PACKAGE esistente...`);
    await fsp.rm(USB_DIR, { recursive: true, force: true });
  }

  // Crea struttura
  await fsp.mkdir(USB_DIR, { recursive: true });
  await fsp.mkdir(USB_CONFIG_DIR, { recursive: true });
  console.log(`✓ Creato: ${USB_DIR}/`);
  console.log(`✓ Creato: ${USB_CONFIG_DIR}/`);

  // Copia exe (rinomina in DJ_Library_Manager.exe se necessario)
  const exeDest = path.join(USB_DIR, EXE_NAME);
  await fsp.copyFile(exeSrc, exeDest);
  console.log(`✓ Copiato: ${EXE_NAME}`);

  // Scarica e estrai fpcalc.exe in USB_PACKAGE
  try {
    const { zipBuf, assetName, releaseTag } = await downloadChromaprintZip();
    const tmpZip = path.join(os.tmpdir(), `chromaprint-${Date.now()}.zip`);
    const tmpExtract = path.join(os.tmpdir(), `chromaprint-extract-${Date.now()}`);
    await fsp.writeFile(tmpZip, zipBuf);

    console.log(`→ Estraggo ${assetName}...`);
    await extractZip(tmpZip, tmpExtract);

    const fpcalcPath = await findFpcalcExe(tmpExtract);
    if (!fpcalcPath) {
      throw new Error(`fpcalc.exe non trovato nell'archivio estratto in ${tmpExtract}`);
    }

    const fpcalcDest = path.join(USB_DIR, FPCALC_NAME);
    await fsp.copyFile(fpcalcPath, fpcalcDest);
    console.log(`✓ Copiato: ${FPCALC_NAME} (chromaprint ${releaseTag})`);

    // Cleanup temp
    await fsp.rm(tmpZip, { force: true });
    await fsp.rm(tmpExtract, { recursive: true, force: true });
  } catch (err) {
    console.warn(`⚠️  Download fpcalc.exe fallito: ${err.message}`);
    console.warn(`   L'app funzionerà comunque se fpcalc.exe è incluso via extraResources.`);
    console.warn(`   Per includerlo esplicitamente in USB_PACKAGE, scaricalo manualmente da:`);
    console.warn(`   https://github.com/acoustid/chromaprint/releases/latest`);
    console.warn(`   e mettilo in: ${USB_DIR}\\${FPCALC_NAME}`);
  }

  // COME_USARE.txt
  await fsp.writeFile(path.join(USB_DIR, 'COME_USARE.txt'), COME_USARE, 'utf8');
  console.log(`✓ Scritto: COME_USARE.txt`);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✓ USB_PACKAGE pronto in:`);
  console.log(`  ${USB_DIR}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`Copia l'intero contenuto di questa cartella sulla chiavetta USB.`);
}

main().catch((err) => {
  console.error('\n✗ Errore fatale:', err.message);
  console.error(err.stack);
  process.exit(1);
});
