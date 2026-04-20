/**
 * scripts/publish.js
 *
 * Pipeline di release automatica end-to-end:
 *   1. Legge la versione da package.json
 *   2. Chiede patch/minor/major + messaggio commit
 *   3. Aggiorna package.json con la nuova versione
 *   4. npm run build:portable (.exe + latest.yml)
 *   5. git add . && git commit -m "vX.Y.Z - msg" && git push origin main
 *   6. Crea una GitHub Release via API e carica .exe + latest.yml come asset
 *
 * Prerequisito: .env con `GITHUB_TOKEN=ghp_...` (scope: repo).
 *   → https://github.com/settings/tokens
 *
 * Run: npm run publish
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync, spawnSync } = require('child_process');
const https = require('https');

require('dotenv').config();

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const DIST_DIR = path.join(ROOT, 'dist');
const EXE_NAME = 'DJ_Library_Manager.exe';
const EXE_PATH = path.join(DIST_DIR, EXE_NAME);
const YML_PATH = path.join(DIST_DIR, 'latest.yml');
const REPO_OWNER = 'nicorossiI';
const REPO_NAME = 'dj-library-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(icon, msg) { console.log(`${icon}  ${msg}`); }
function fail(msg) { console.error(`\n❌  ${msg}\n`); process.exit(1); }

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function bumpVersion(current, kind) {
  const m = String(current).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`Versione non semver: ${current}`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major')      { major++; minor = 0; patch = 0; }
  else if (kind === 'minor') { minor++; patch = 0; }
  else if (kind === 'patch') { patch++; }
  else throw new Error(`Tipo sconosciuto: ${kind}`);
  return `${major}.${minor}.${patch}`;
}

function sh(cmd, opts = {}) {
  log('→', cmd);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

// ---------------------------------------------------------------------------
// GitHub API (native https, zero-dep oltre a quelle già installate)
// ---------------------------------------------------------------------------

function githubRequest({ host, path: urlPath, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path: urlPath, method,
      headers: {
        'User-Agent': 'dj-library-manager-publish',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(text)); }
          catch { resolve(text); }
        } else {
          reject(new Error(`GitHub API ${method} ${urlPath} → ${res.statusCode}: ${text}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function createRelease(token, { tag, name, body }) {
  return githubRequest({
    host: 'api.github.com',
    path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: 'main',
      name,
      body,
      draft: false,
      prerelease: false,
    }),
  });
}

async function uploadAsset(token, releaseId, filePath) {
  const fileName = path.basename(filePath);
  const data = fs.readFileSync(filePath);
  const contentType = fileName.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
  log('📤', `Upload ${fileName} (${(data.length / 1024 / 1024).toFixed(1)} MB)...`);
  return githubRequest({
    host: 'uploads.github.com',
    path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': contentType,
      'Content-Length': data.length,
    },
    body: data,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Parse CLI args: --kind=patch|minor|major --message="..." --yes
function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    let m;
    if ((m = a.match(/^--kind=(.+)$/)))     out.kind = m[1];
    else if ((m = a.match(/^--message=(.+)$/))) out.message = m[1];
    else if (a === '--yes' || a === '-y')       out.yes = true;
    else if (a === '--patch') out.kind = 'patch';
    else if (a === '--minor') out.kind = 'minor';
    else if (a === '--major') out.kind = 'major';
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const nonInteractive = !!(args.kind && args.message);

  // 0) Preflight
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    fail('GITHUB_TOKEN mancante nel .env — https://github.com/settings/tokens (scope: repo)');
  }

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT }).toString().trim();
    if (branch !== 'main' && !nonInteractive) {
      const proceed = await ask(`⚠️  Sei sul branch "${branch}" (non "main"). Continuare? [y/N]: `);
      if (!/^y/i.test(proceed)) fail('Annullato.');
    }
  } catch { /* ignore */ }

  // 1) Leggi versione attuale
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const currentVersion = pkg.version;
  log('📦', `Versione attuale: ${currentVersion}`);

  // 2) Chiedi tipo di bump + messaggio (o prendili da CLI)
  let kind, message;
  if (nonInteractive) {
    kind = args.kind;
    message = args.message;
    log('⚙️ ', `Modalità non-interattiva: kind=${kind}`);
  } else {
    console.log('\nTipo di aggiornamento:');
    console.log('  1) patch  (bugfix)              →', bumpVersion(currentVersion, 'patch'));
    console.log('  2) minor  (nuova feature)       →', bumpVersion(currentVersion, 'minor'));
    console.log('  3) major  (breaking change)    →', bumpVersion(currentVersion, 'major'));

    const choice = (await ask('\nScelta [1/2/3] (default 1): ')).trim() || '1';
    kind = { '1': 'patch', '2': 'minor', '3': 'major',
             'patch': 'patch', 'minor': 'minor', 'major': 'major' }[choice.toLowerCase()];
    if (!kind) fail(`Scelta non valida: ${choice}`);
    message = (await ask(`Messaggio commit (es. "fix crash on rename"): `)).trim();
  }
  if (!kind) fail('Tipo di aggiornamento obbligatorio.');
  if (!message) fail('Messaggio commit obbligatorio.');

  const newVersion = bumpVersion(currentVersion, kind);
  const commitMsg = `v${newVersion} - ${message}`;
  const tag = `v${newVersion}`;

  console.log('');
  log('🎯', `Nuova versione: ${newVersion}`);
  log('💬', `Commit: ${commitMsg}`);
  log('🏷️ ', `Tag: ${tag}`);
  if (!nonInteractive && !args.yes) {
    const confirm = await ask('\nConfermi? [Y/n]: ');
    if (/^n/i.test(confirm)) fail('Annullato.');
  }

  // 3) Aggiorna package.json
  pkg.version = newVersion;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  log('✏️ ', `package.json → ${newVersion}`);

  // 4) Build portable (.exe + latest.yml)
  console.log('');
  log('🔨', 'npm run build:portable');
  sh('npm run build:portable');

  if (!fs.existsSync(EXE_PATH)) fail(`.exe non trovato: ${EXE_PATH}`);
  if (!fs.existsSync(YML_PATH)) fail(`latest.yml non trovato: ${YML_PATH}`);
  log('✅', `Build: ${EXE_PATH}`);

  // 5) Git add + commit + push (con rollback se il push fallisce)
  console.log('');
  sh('git add .');
  const commitResult = spawnSync('git', ['commit', '-m', commitMsg], {
    cwd: ROOT, stdio: 'inherit',
  });
  if (commitResult.status !== 0) fail('git commit fallito.');
  sh(`git tag ${tag}`);

  try {
    sh('git push origin main');
    sh(`git push origin ${tag}`);
  } catch (pushErr) {
    console.error('\n❌  Push fallito — rollback commit, tag e version bump locali...');
    try { execSync(`git reset --soft HEAD~1`, { cwd: ROOT, stdio: 'inherit' }); } catch { /* noop */ }
    try { execSync(`git tag -d ${tag}`, { cwd: ROOT, stdio: 'inherit' }); } catch { /* noop */ }
    try { execSync(`git checkout -- package.json`, { cwd: ROOT, stdio: 'inherit' }); } catch { /* noop */ }
    fail(`Push fallito: ${pushErr.message}`);
  }

  // 6) GitHub Release + upload asset
  console.log('');
  log('🚀', `Creo GitHub Release ${tag}...`);
  const release = await createRelease(token, {
    tag,
    name: tag,
    body: message,
  });
  log('✅', `Release creata: ${release.html_url}`);

  await uploadAsset(token, release.id, EXE_PATH);
  log('✅', `${EXE_NAME} caricato`);
  await uploadAsset(token, release.id, YML_PATH);
  log('✅', 'latest.yml caricato');

  console.log('');
  log('🎉', `Release ${tag} pubblicata: ${release.html_url}`);
}

main().catch(err => fail(err.message || String(err)));
