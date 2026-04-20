/**
 * src/renderer/renderer.js
 *
 * Logica UI vanilla: stato in-memory + binding pulsanti + render per i 6 tab.
 * Comunica con il main via window.api esposto da preload.js.
 *
 * Tabs: carica → analisi → doppioni → rinomina → organizza → rekordbox
 */

'use strict';

// ============================================================================
// STATE
// ============================================================================

const state = {
  files: [],                  // Track[] caricati (post-scan)
  duplicates: [],             // DuplicateGroup[] dal main
  crossMixDuplicates: [],     // Canzoni ripetute in più mix diversi
  dupesSelectedIds: new Set(),// trackId selezionati per eliminazione manuale
  renamePreview: [],          // preview rinomina
  renameSelectedIds: new Set(),
  renameFilter: 'all',
  organize: { tree: null, stats: null, outputRoot: '', completed: false },
  rekordbox: { xmlPath: '' },
  settings: null,
  apiOnline: false,
  analysis: { startedAt: 0, lastTotal: 0, lastDone: 0, eta: '' },
  analysisDone: false,          // true solo dopo onAnalysisComplete
  analysisRunning: false,       // true tra startAnalysis e onAnalysisComplete
  logs: [],
  // Modalità "aggiungi a libreria esistente"
  mode: 'new',                  // 'new' | 'update'
  existingRoot: '',             // path della libreria esistente (in update-mode)
  updateResult: null,           // { duplicatesFound, newTracksAdded, duplicates[], xmlUpdated }
};

const GATED_TABS = new Set(['doppioni', 'rinomina', 'organizza', 'rekordbox']);

const LOG_MAX = 100;

// ============================================================================
// DOM HELPERS
// ============================================================================

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDuration(sec) {
  if (!sec) return '—';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * Modal di conferma generico. Usa le classi CSS esistenti (.modal, .modal-*).
 * Ritorna Promise<boolean> — true se l'utente ha cliccato conferma.
 *
 * @param {{title:string, body:string, confirmText?:string,
 *          cancelText?:string, danger?:boolean}} opts
 */
function showConfirmModal({ title, body, confirmText = 'Conferma', cancelText = 'Annulla', danger = false }) {
  return new Promise(resolve => {
    const root = document.createElement('div');
    root.className = 'modal';
    root.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content modal-sm">
        <div class="modal-header">
          <h2>${escapeHtml(title)}</h2>
        </div>
        <div class="modal-body">
          <p style="white-space:pre-line; line-height:1.5">${escapeHtml(body)}</p>
        </div>
        <div class="modal-footer" style="display:flex; gap:10px; justify-content:flex-end; padding:14px 20px; border-top:1px solid var(--border-glass)">
          <button class="btn btn-ghost" data-act="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    const cleanup = (value) => {
      root.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter')  cleanup(true);
    };
    document.addEventListener('keydown', onKey);
    root.querySelector('[data-act="cancel"]').addEventListener('click', () => cleanup(false));
    root.querySelector('[data-act="confirm"]').addEventListener('click', () => cleanup(true));
    root.querySelector('.modal-backdrop').addEventListener('click', () => cleanup(false));
    // Focus sul conferma per UX tastiera
    setTimeout(() => root.querySelector('[data-act="confirm"]')?.focus(), 0);
  });
}

function bestTitle(t) {
  return t.recognizedTitle || t.localTitle || (t.fileName || '').replace(/\.[^.]+$/, '') || 'Unknown';
}
function bestArtist(t) {
  return t.recognizedArtist || t.localArtist || 'Unknown';
}
function trackType(t) {
  return t.type || (t.isMix ? 'mix' : (t.isMashup ? 'mashup' : 'single'));
}

// Badge "fonte riconoscimento" (identità + genere)
const SOURCE_LABELS = {
  acrcloud: { label: 'ACRCloud', cls: 'src-acr' },
  acoustid_musicbrainz: { label: 'AcoustID/MB', cls: 'src-mb' },
  shazam: { label: '🎵 Shazam', cls: 'src-shazam' },
  shazam_genre: { label: 'Shazam genre', cls: 'src-shazam' },
  discogs: { label: 'Discogs', cls: 'src-discogs' },
  lastfm: { label: 'Last.fm', cls: 'src-lastfm' },
  id3_tags: { label: 'Tag ID3', cls: 'src-id3' },
  filename_parser: { label: 'Nome file', cls: 'src-filename' },
  none: { label: 'Non riconosciuto', cls: 'src-none' },
  path: { label: 'Cartella', cls: 'src-path' },
  filename: { label: 'Nome file', cls: 'src-filename' },
  artist_filename: { label: 'Artista (nome)', cls: 'src-filename' },
  id3_genre: { label: 'Tag ID3', cls: 'src-id3' },
  artist_hint: { label: 'Hint artista', cls: 'src-hint' },
  mbgenre: { label: 'MusicBrainz', cls: 'src-mb' },
  title_kw: { label: 'Titolo (kw)', cls: 'src-hint' },
  bpm_range: { label: 'BPM', cls: 'src-bpm' },
};

function renderSourceBadge(sourceKey) {
  if (!sourceKey) return '';
  const info = SOURCE_LABELS[sourceKey] || { label: sourceKey, cls: 'src-none' };
  return `<span class="badge badge-source ${info.cls}">${escapeHtml(info.label)}</span>`;
}

const LANG_LABELS = {
  'es':    '🇪🇸 Spagnolo',
  'it':    '🇮🇹 Italiano',
  'it_es': '🇮🇹🇪🇸 IT+ES',
  'en':    '🇬🇧 Inglese',
  'mixed': '🌍 Misto',
  'instrumental': '🎹 Strumentale',
};

function renderLanguageBadge(lang) {
  if (!lang) return '';
  const key = String(lang).toLowerCase();
  const label = LANG_LABELS[key];
  if (!label) return '';
  return `<span class="badge badge-lang-${key}">${label}</span>`;
}

// ============================================================================
// TAB SWITCHING
// ============================================================================

function updateTabsGating() {
  const locked = !state.analysisDone;
  $$('.tab-btn').forEach(b => {
    const shouldLock = locked && GATED_TABS.has(b.dataset.tab);
    b.classList.toggle('disabled', shouldLock);
  });
}

function switchTab(name) {
  // Blocca navigazione verso tab gated se analisi non finita
  if (!state.analysisDone && GATED_TABS.has(name)) {
    pushLog({ level: 'warn', icon: '⚠️', message: `Tab "${name}" disponibile solo dopo l'analisi completa.` });
    return;
  }
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));

  // Render lazy quando si entra in un tab
  if (name === 'doppioni') renderDuplicates();
  if (name === 'rinomina') renderRenameTable();
  if (name === 'organizza') maybeRefreshOrganize();
  if (name === 'rekordbox') renderRekordboxPreview();
}

// ============================================================================
// LOGGING
// ============================================================================

function pushLog({ level = 'info', icon = 'ℹ️', message = '', ts = Date.now() }) {
  state.logs.unshift({ level, icon, message, ts });
  if (state.logs.length > LOG_MAX) state.logs.length = LOG_MAX;
  renderLog();
}

function renderLog() {
  const host = $('#log-list');
  if (!host) return;
  host.innerHTML = state.logs.map(l => {
    const time = new Date(l.ts).toLocaleTimeString();
    return `<div class="log-line log-${l.level}">${escapeHtml(time)}  ${l.icon}  ${escapeHtml(l.message)}</div>`;
  }).join('');
}

// ============================================================================
// API STATUS
// ============================================================================

async function refreshApiStatus() {
  try {
    const r = await window.api.testApi();
    const online = !!(r.ok && r.data?.online);
    state.apiOnline = online;
    const el = $('#api-status');
    el.classList.toggle('status-online', online);
    el.classList.toggle('status-offline', !online);
    $('.status-label', el).textContent = online ? 'ACRCloud Online' : 'ACRCloud Offline (solo fingerprint locale)';
  } catch { /* noop */ }
}

// ============================================================================
// TAB 1: CARICA
// ============================================================================

function renderFilesTable() {
  const body = $('#files-tbody');
  if (state.files.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="8">Nessun file caricato</td></tr>';
  } else {
    body.innerHTML = state.files.map((t, i) => {
      const type = trackType(t);
      const typeIcon = type === 'mix' ? '🎛️' : type === 'mashup' ? '🔀' : '🎵';
      const typeLabel = type === 'mix' ? 'Mix' : type === 'mashup' ? 'Mashup' : 'Singolo';
      const status = t.status || 'pending';
      const statusBadge = statusBadgeFor(status);
      const bpmCell = (t.bpm && Number(t.bpm) > 0) ? Math.round(Number(t.bpm)) : '—';
      const keyCell = t.key ? escapeHtml(t.key) : '—';
      return `<tr>
        <td>${i + 1}</td>
        <td class="file-name-cell">${escapeHtml(t.fileName || t.filePath || '')}</td>
        <td>${fmtDuration(t.duration)}</td>
        <td>${fmtSize(t.fileSize)}</td>
        <td>${bpmCell}</td>
        <td>${keyCell}</td>
        <td><span class="badge badge-type-${type}">${typeIcon} ${typeLabel}</span></td>
        <td>${statusBadge}</td>
      </tr>`;
    }).join('');
  }

  // Counters
  const singles = state.files.filter(t => trackType(t) === 'single').length;
  const mixes = state.files.filter(t => trackType(t) === 'mix').length;
  const mashups = state.files.filter(t => trackType(t) === 'mashup').length;
  $('#cnt-singles').textContent = singles;
  $('#cnt-mix').textContent = mixes;
  $('#cnt-mashup').textContent = mashups;
  $('#cnt-total').textContent = state.files.length;

  $('#btn-start-analysis').disabled = state.files.length === 0;
}

function statusBadgeFor(status) {
  switch (status) {
    case 'pending':       return '<span class="badge badge-status-pending">⏳ In attesa</span>';
    case 'fingerprinted':
    case 'classified':
    case 'recognized':    return '<span class="badge badge-status-ok">✓ Analizzato</span>';
    case 'renamed':
    case 'organized':
    case 'exported':      return '<span class="badge badge-status-ok">✓ ' + status + '</span>';
    case 'error':         return '<span class="badge badge-status-error">❌ Errore</span>';
    default:              return '<span class="badge badge-status-warn">⚠️ Da verificare</span>';
  }
}

async function loadFolder() {
  const r = await window.api.selectFolder();
  if (!r.ok || !r.data) return;
  pushLog({ level: 'info', icon: '📁', message: `Cartella: ${r.data}` });
  await scanFolder(r.data);
}

async function loadFiles() {
  const r = await window.api.selectFiles();
  if (!r.ok || !r.data?.length) return;
  pushLog({ level: 'info', icon: '🎵', message: `${r.data.length} file selezionati` });
  await scanFiles(r.data);
}

async function scanFolder(folder) {
  pushLog({ level: 'info', icon: '🔎', message: 'Scansione cartella...' });
  const r = await window.api.scanFolder(folder);
  if (!r.ok) { pushLog({ level: 'error', icon: '❌', message: `Scan errore: ${r.error}` }); return; }
  state.files = r.data;
  renderFilesTable();
  pushLog({ level: 'success', icon: '✓', message: `Scansionati ${state.files.length} file` });
  // Auto-trigger analisi completa senza attendere click utente
  if (state.files.length > 0) await startAnalysis();
}

async function scanFiles(paths) {
  // Loading state: drop di 50-500 file può metterci qualche secondo per la
  // sola lettura metadati. Senza feedback la UI sembra congelata.
  const dz = document.querySelector('#drop-zone');
  dz?.classList.add('loading');
  try {
    const r = await window.api.scanFiles(paths);
    if (!r.ok) { pushLog({ level: 'error', icon: '❌', message: `Scan errore: ${r.error}` }); return; }
    const seen = new Set(state.files.map(f => f.filePath));
    for (const t of r.data) if (!seen.has(t.filePath)) state.files.push(t);
    renderFilesTable();
    pushLog({ level: 'success', icon: '✓', message: `Caricati ${r.data.length} file` });
    if (r.data.length > 0) await startAnalysis();
  } finally {
    dz?.classList.remove('loading');
  }
}

// ── Drop zone ─────────────────────────────────────────────────────────
function setupDropZone() {
  const dz = $('#drop-zone');
  ['dragenter', 'dragover'].forEach(ev => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.remove('drag-over');
    });
  });
  dz.addEventListener('drop', async (e) => {
    const files = e.dataTransfer?.files || [];
    if (!files.length) return;
    const paths = [];
    for (const f of files) {
      // Electron v32+: File.path rimosso per sicurezza, serve webUtils via preload
      const p = window.api.getPathForFile?.(f) || f.path || '';
      if (p) paths.push(p);
    }
    if (paths.length === 0) {
      pushLog({ level: 'warn', icon: '⚠️', message: 'Drop ricevuto ma nessun path disponibile (verifica che siano file, non cartelle)' });
      return;
    }
    pushLog({ level: 'info', icon: '📥', message: `${paths.length} file droppati` });
    await scanFiles(paths);
  });
}

// ============================================================================
// TAB 2: ANALISI
// ============================================================================

async function startAnalysis() {
  if (state.files.length === 0) return;
  if (state.analysisRunning) return; // anti-rientranza
  state.analysisRunning = true;
  state.analysisDone = false;
  updateTabsGating();
  // Forza switch su tab analisi (anche se altri tab sono gated)
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'analisi'));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === 'analisi'));
  state.analysis.startedAt = Date.now();
  $('#phase-label').textContent = 'Avvio analisi...';
  setProgress(0, 0);

  const r = await window.api.analyzeFull(state.files);
  if (!r.ok) {
    pushLog({ level: 'error', icon: '❌', message: `Analisi fallita: ${r.error}` });
    state.analysisRunning = false;
    return;
  }
  state.files = r.data;
  renderFilesTable();
  $('#phase-label').textContent = '✓ Analisi completata';
  refreshAnalysisStats();

  pushLog({ level: 'success', icon: '✅', message: `Analisi completata in ${formatElapsed(Date.now() - state.analysis.startedAt)}` });

  // Calcola subito doppioni in background (per popolare tab 3)
  await refreshDuplicates();

  // Se in modalità "aggiungi a libreria esistente", lancia il confronto
  if (state.mode === 'update' && state.existingRoot) {
    await runUpdateAgainstExisting();
  }

  // Safety net: se l'event onAnalysisComplete non è arrivato, sblocca comunque
  state.analysisDone = true;
  state.analysisRunning = false;
  updateTabsGating();

  // ── PIPELINE "FAI TUTTO": rinomina → organizza → rekordbox → modal ─
  await runDoEverythingPipeline();
}

// ── Policy sicurezza doppioni ────────────────────────────────────
// Un gruppo è auto-eliminabile SOLO se: non richiede revisione manuale,
// ha match acustico esatto (acoustic_exact) e score ≥ 0.95.
// Text match e acoustic_similar vengono sempre lasciati al tab Doppioni.
const AUTO_DELETE_MIN_SCORE = 0.95;
const AUTO_DELETE_BATCH_CAP = 500;

function isAutoDeletable(group) {
  if (!group) return false;
  if (group.requiresManualReview) return false;
  if (group.matchType !== 'acoustic_exact' && group.matchType !== 'acr_exact') return false;
  return Number(group.similarityScore || 0) >= AUTO_DELETE_MIN_SCORE;
}

async function runDoEverythingPipeline() {
  const stats = { renamed: 0, folders: 0, duplicates: 0, deleted: 0, xmlOk: false };
  try {
    // 1. Auto-elimina SOLO doppioni acustici certi (≥95%). Text match e
    //    acoustic_similar → tab Doppioni per revisione umana.
    const safeGroups = (state.duplicates || []).filter(isAutoDeletable);
    const reviewGroups = (state.duplicates || []).filter(g => !isAutoDeletable(g));
    const toDeleteItems = [];
    for (const g of safeGroups) {
      for (const it of (g.items || [])) {
        if (!it.recommended && it.filePath) toDeleteItems.push({
          filePath: it.filePath,
          fileSize: it.fileSize || 0,
          keeperPath: g.items.find(x => x.recommended)?.filePath || '',
          matchType: g.matchType,
          score: g.similarityScore,
        });
      }
    }
    const toDeletePaths = toDeleteItems.map(x => x.filePath);
    const totalBytes = toDeleteItems.reduce((s, x) => s + (x.fileSize || 0), 0);

    // Safety cap: troppi doppioni → abort, serve revisione umana
    if (toDeletePaths.length > AUTO_DELETE_BATCH_CAP) {
      pushLog({
        level: 'warn', icon: '⚠️',
        message: `Troppi doppioni (${toDeletePaths.length}) — skip auto-delete, revisiona nel tab Doppioni`,
      });
    } else if (toDeletePaths.length > 0) {
      // Conferma SEMPRE prima di cestinare
      const sizeMb = (totalBytes / 1024 / 1024).toFixed(1);
      const reviewNote = reviewGroups.length > 0
        ? `\n\n⚠️ ${reviewGroups.length} gruppi aggiuntivi richiedono revisione manuale (tab Doppioni).`
        : '';
      const ok = await showConfirmModal({
        title: '🗑️ Elimina doppioni',
        body:
          `Sto per spostare nel Cestino:\n\n` +
          `• ${toDeletePaths.length} file (${sizeMb} MB)\n` +
          `• Solo doppioni acustici certi (≥${Math.round(AUTO_DELETE_MIN_SCORE * 100)}% simili)` +
          reviewNote +
          `\n\nPuoi recuperarli dal Cestino di Windows.`,
        confirmText: 'Sposta nel Cestino',
        cancelText: 'Annulla',
      });
      if (ok) {
        pushLog({ level: 'info', icon: '🗑️', message: `Elimino ${toDeletePaths.length} doppioni (nel Cestino)...` });
        const del = await window.api.autoDeleteDuplicates({ items: toDeleteItems });
        if (del.ok) {
          stats.deleted = del.data?.deleted || 0;
          const removed = new Set(toDeletePaths);
          state.files = state.files.filter(t => !removed.has(t.filePath));
          // Tieni solo i gruppi che richiedono revisione manuale
          state.duplicates = reviewGroups;
          renderFilesTable();
          renderDuplicates();
        } else {
          pushLog({ level: 'error', icon: '❌', message: `Auto-delete: ${del.error}` });
        }
      } else {
        pushLog({ level: 'info', icon: 'ℹ️', message: 'Auto-delete annullato' });
      }
    }

    // 2. Prepara nomi nuovi (usati dall'organize per copiare con nome pulito).
    //    NON rinomina fisicamente gli originali — la rinomina è applicata
    //    nella COPIA dentro "DJ Library Organizzata".
    await refreshRenamePreview();
    stats.renamed = (state.renamePreview || []).filter(p => p.canRename).length;

    // 3. Organizza: copia i file con il newFileName nelle cartelle genere/lingua
    pushLog({ level: 'info', icon: '📁', message: 'Organizzazione cartelle in corso...' });
    await maybeRefreshOrganize();
    if (state.organize.outputRoot) {
      const first = state.files[0];
      const sourceFolder = first?.filePath ? first.filePath.split(/[\\/]/).slice(0, -1).join('/') : '';
      const or = await window.api.executeOrganization({ tracks: state.files, sourceFolder });
      if (or.ok) {
        state.organize.completed = true;
        state.organize.outputRoot = or.data.outputRoot;
        stats.folders = or.data.foldersCreated || state.organize.stats?.foldersToCreate || 0;
        pushLog({ level: 'success', icon: '✓', message: `Libreria pronta in ${or.data.outputRoot}` });
      } else {
        pushLog({ level: 'error', icon: '❌', message: `Organizza: ${or.error}` });
      }
    }

    // 4. Rekordbox XML
    if (state.organize.completed && state.organize.outputRoot) {
      pushLog({ level: 'info', icon: '🎛️', message: 'Generazione rekordbox.xml...' });
      const xr = await window.api.rekordboxGenerate();
      if (xr.ok) {
        state.rekordbox.xmlPath = xr.data.xmlPath;
        stats.xmlOk = true;
        pushLog({ level: 'success', icon: '✓', message: `rekordbox.xml pronto` });
      } else {
        pushLog({ level: 'error', icon: '❌', message: `Rekordbox: ${xr.error}` });
      }
    }

    showFinalResultModal(stats);
  } catch (err) {
    pushLog({ level: 'error', icon: '❌', message: `Pipeline: ${err.message}` });
  }
}

function showFinalResultModal(stats) {
  $('#fr-renamed').textContent = stats.renamed || 0;
  $('#fr-folders').textContent = stats.folders || 0;
  $('#fr-dupes').textContent = stats.deleted || 0;
  $('#fr-xml-status').textContent = stats.xmlOk
    ? 'Rekordbox aggiornato'
    : 'Rekordbox non generato';
  showModal('final-result');
}

function setProgress(done, total, label, current) {
  state.analysis.lastDone = done;
  state.analysis.lastTotal = total;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $('#analysis-progress-bar').style.width = `${pct}%`;
  $('#progress-pct').textContent = `${pct}%`;
  if (label) $('#phase-label').textContent = current ? `${label} — ${current}` : label;

  // ETA
  if (state.analysis.startedAt && done > 0 && total > 0) {
    const elapsed = Date.now() - state.analysis.startedAt;
    const totalEst = (elapsed / done) * total;
    const remaining = Math.max(0, totalEst - elapsed);
    $('#progress-eta').textContent = remaining > 0 ? `~${formatElapsed(remaining)} rimasti` : '';
  }
  refreshAnalysisStats();
}

function refreshAnalysisStats() {
  const recognized = state.files.filter(t => t.isRecognized).length;
  const unrecognized = state.files.filter(t => !t.isRecognized && (t.status === 'classified' || t.status === 'recognized')).length;
  const mix = state.files.filter(t => trackType(t) === 'mix').length;
  const fp = state.files.filter(t => !!t.fingerprint).length;
  const bpmCount = state.files.filter(t => t.bpm && Number(t.bpm) > 0).length;
  const keyCount = state.files.filter(t => !!t.key).length;
  const elBpm = $('#stat-bpm'); if (elBpm) elBpm.textContent = bpmCount;
  const elKey = $('#stat-keys'); if (elKey) elKey.textContent = keyCount;
  $('#stat-recognized').textContent = recognized;
  $('#stat-unrecognized').textContent = unrecognized;
  $('#stat-mix').textContent = mix;
  $('#stat-fp').textContent = fp;
}

function formatElapsed(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

// ============================================================================
// TAB 3: DOPPIONI
// ============================================================================

async function refreshDuplicates() {
  const r = await window.api.findDuplicates(state.files);
  if (!r.ok) { pushLog({ level: 'error', icon: '❌', message: `Doppioni: ${r.error}` }); return; }
  state.duplicates = r.data;
  renderDuplicates();
}

function classifyDuplicateGroup(g) {
  // Categorizza la sezione di appartenenza
  if (g.type === 'single_mix') return 'mix-vs-lib';
  if (g.type === 'mix_mix')    return 'mix-mix';
  return 'singles';
}

function renderDuplicates() {
  const groups = state.duplicates || [];
  const buckets = { 'mix-vs-lib': [], 'singles': [], 'mix-mix': [] };
  for (const g of groups) buckets[classifyDuplicateGroup(g)].push(g);

  $('#cnt-mix-vs-lib').textContent = `${buckets['mix-vs-lib'].length} gruppi`;
  $('#cnt-singles-dup').textContent = `${buckets['singles'].length} gruppi`;
  $('#cnt-mix-mix').textContent = `${buckets['mix-mix'].length} gruppi`;

  $('#body-mix-vs-lib').innerHTML = renderDupBucket(buckets['mix-vs-lib']);
  $('#body-singles').innerHTML = renderDupBucket(buckets['singles']);
  $('#body-mix-mix').innerHTML = renderDupBucket(buckets['mix-mix']);

  // Sezione CROSS-MIX: canzoni presenti in più mix diversi
  const cross = state.crossMixDuplicates || [];
  $('#cnt-cross-mix').textContent = `${cross.length} canzon${cross.length === 1 ? 'e' : 'i'}`;
  $('#body-cross-mix').innerHTML = renderCrossMixBucket(cross);

  // Sezione "Già in libreria" — popolata solo in modalità update
  const inLibSection = $('#dupes-section-in-library');
  const inLibDupes = state.updateResult?.duplicates || [];
  if (state.mode === 'update' && inLibDupes.length > 0) {
    inLibSection.style.display = '';
    $('#cnt-in-library').textContent = `${inLibDupes.length} file`;
    $('#body-in-library').innerHTML = renderInLibraryBucket(inLibDupes);
  } else if (inLibSection) {
    inLibSection.style.display = 'none';
  }

  // Bind checkbox handlers
  $$('input[data-dup-item]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.dupItem;
      if (cb.checked) state.dupesSelectedIds.add(id);
      else state.dupesSelectedIds.delete(id);
      refreshDeleteList();
    });
  });

  refreshDeleteList();
}

function renderInLibraryBucket(duplicates) {
  if (!duplicates.length) return '<p class="muted">Nessun file già presente in libreria.</p>';
  return duplicates.map(d => {
    const sim = Math.round((d.similarity || 0) * 100);
    const newName = d.newTrack?.fileName || d.newTrack?.filePath || '';
    const folder = d.existingFolder || '—';
    const existFile = d.existingFileName || '';
    return `<div class="dupe-group">
      <div class="dupe-group-head">
        <span class="badge badge-in-library">🟣 GIÀ IN LIBRERIA</span>
        <span class="muted">Similarità acustica: ${sim}%</span>
      </div>
      <div class="dupe-group-cards">
        <div class="dupe-card in-library">
          <div class="dupe-card-head"><span>🆕 NUOVO FILE</span></div>
          <div class="dupe-card-name">${escapeHtml(newName)}</div>
        </div>
        <div class="dupe-card in-library">
          <div class="dupe-card-head"><span>📁 GIÀ IN</span></div>
          <div class="dupe-card-name">${escapeHtml(existFile)}</div>
          <div class="dupe-card-sub"><strong>${escapeHtml(folder)}</strong></div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderCrossMixBucket(items) {
  if (!items.length) {
    return '<p class="muted">Nessuna canzone ripetuta in più mix.</p>';
  }
  return items.map(d => {
    const fp = d.fingerprintConfirmed;
    const fpBadge = fp == null
      ? '<span class="badge badge-method">audio non verificato</span>'
      : `<span class="badge ${fp >= 80 ? 'badge-match-exact' : fp >= 60 ? 'badge-match-similar' : 'badge-method'}">✓ ${fp}% similarità Chromaprint</span>`;

    const rows = (d.appearances || []).map(a => `
      <div class="cross-mix-row">
        <span class="cross-mix-icon">📼</span>
        <span class="cross-mix-file">${escapeHtml(a.mixFileName || '(sconosciuto)')}</span>
        <span class="cross-mix-arrow">→ a</span>
        <span class="cross-mix-ts">${escapeHtml(a.segmentTimestamp || '—')}</span>
      </div>
    `).join('');

    return `<div class="cross-mix-card">
      <div class="cross-mix-head">
        <span class="cross-mix-title-ico">🔁</span>
        <div>
          <div class="cross-mix-title">"${escapeHtml(d.artist || '?')} - ${escapeHtml(d.title || '?')}"</div>
          <div class="cross-mix-sub muted">appare in ${d.appearances.length} mix diversi</div>
        </div>
      </div>
      <div class="cross-mix-body">${rows}</div>
      <div class="cross-mix-footer">
        ${fpBadge}
        <span class="muted">Questo NON è un problema — info utile per sapere quali mix condividono canzoni.</span>
      </div>
    </div>`;
  }).join('');
}

function renderDupBucket(groups) {
  if (groups.length === 0) return '<p class="muted">Nessun duplicato in questa categoria.</p>';
  return groups.map(g => renderDupGroup(g)).join('');
}

function renderDupGroup(g) {
  // Badge principale: 3 livelli di fiducia.
  let matchClass, matchLabel, safetyBadge, safetyNote = '';
  if (g.matchType === 'acoustic_exact' && !g.requiresManualReview) {
    matchClass = 'badge-match-exact';
    matchLabel = '🔴 IDENTICO';
    safetyBadge = '<span class="badge badge-safe">✅ Sicuro eliminare</span>';
  } else if (g.matchType === 'acoustic_similar') {
    matchClass = 'badge-match-similar';
    matchLabel = '🟠 SIMILE';
    safetyBadge = '<span class="badge badge-warn">⚡ Verifica consigliata</span>';
    safetyNote = 'Fingerprint acustico simile ma non identico. Ascolta entrambi.';
  } else {
    matchClass = 'badge-match-similar';
    matchLabel = '🟡 TEXT MATCH';
    safetyBadge = '<span class="badge badge-review">⚠️ Revisione richiesta</span>';
    safetyNote = 'Match trovato solo per nome/artista, non confermato acusticamente. Ascolta entrambi prima di eliminare.';
  }

  const methodLabel = g.matchType === 'text_match' ? 'Testo (fuse.js)'
                    : g.matchType === 'acr_exact'  ? 'ACRCloud'
                    : 'Chromaprint';
  const cards = (g.items || []).map(it =>
    renderDupCard(it, { requiresManualReview: !!g.requiresManualReview })
  ).join('');
  const note = safetyNote
    ? `<div class="dupe-group-note">${escapeHtml(safetyNote)}</div>`
    : '';

  return `<div class="dupe-group ${g.requiresManualReview ? 'needs-review' : ''}">
    <div class="dupe-group-head">
      <span class="badge ${matchClass}">${matchLabel}</span>
      ${safetyBadge}
      <span class="muted">Similarità: ${Math.round((g.similarityScore || 0) * 100)}%</span>
      <span class="badge badge-method">[${methodLabel}]</span>
    </div>
    ${note}
    <div class="dupe-group-cards">${cards}</div>
  </div>`;
}

function renderDupCard(it, opts = {}) {
  const isMixSeg = !!it.isMixSegment;
  const cardClass = it.recommended ? 'dupe-card recommended' : 'dupe-card';
  const head = isMixSeg ? '🎛️ NEL MIX' : '🎵 FILE SINGOLO';
  const reason = it.recommended && it.recommendedReason ? it.recommendedReason : '';
  const recBadge = it.recommended
    ? `<span class="badge-recommended" data-tooltip="${escapeHtml(reason || 'qualità migliore')}">★ CONSIGLIATO${reason ? ' — ' + escapeHtml(reason) : ''}</span>`
    : '';
  // Se il gruppo richiede revisione manuale, il checkbox "Elimina" NON è
  // pre-attivato dal "Fai Tutto". L'utente può comunque selezionarlo a mano.
  const needsReview = !!opts.requiresManualReview;

  // Badge qualità: formato + bitrate con codice colore
  //  ≥300  → verde  (320 kbps / lossless)
  //  200-299 → giallo (256 / 192)
  //  <200  → rosso   (128 o peggio)
  const qualityParts = [];
  if (it.format) qualityParts.push(`<span class="badge badge-format">${escapeHtml(String(it.format).toUpperCase())}</span>`);
  if (it.bitrate && Number(it.bitrate) > 0) {
    const br = Number(it.bitrate);
    const brClass = br >= 300 ? 'badge-bitrate' : (br >= 200 ? 'badge-bitrate-med' : 'badge-bitrate-low');
    qualityParts.push(`<span class="badge ${brClass}">${Math.round(br)} kbps</span>`);
  }
  const qualityBadges = qualityParts.length ? `<div class="dupe-card-quality">${qualityParts.join(' ')}</div>` : '';

  const meta = isMixSeg
    ? `<div class="dupe-card-meta">Traccia ${it.segmentIndex || '?'} • Timestamp: ${it.segmentTimestamp || '—'}</div>`
    : `<div class="dupe-card-meta">📏 ${fmtSize(it.fileSize)}  ⏱ ${fmtDuration(it.duration)}</div>`;

  const id = it.trackId || '';
  const checked = state.dupesSelectedIds.has(id) ? 'checked' : '';

  const reviewBadge = needsReview
    ? '<span class="badge badge-review" style="font-size:10px">revisione</span>'
    : '';
  return `<div class="${cardClass}">
    <div class="dupe-card-head">
      <span>${head}</span>${recBadge}${reviewBadge}
    </div>
    <div class="dupe-card-name">${escapeHtml(it.displayName || it.filePath || '')}</div>
    ${qualityBadges}
    ${meta}
    <div class="dupe-card-actions">
      <button class="btn btn-ghost" data-dup-keep="${escapeHtml(id)}">☑ Tieni</button>
      <label class="btn">
        <input type="checkbox" data-dup-item="${escapeHtml(id)}" ${checked} style="margin-right:6px">Elimina
      </label>
    </div>
  </div>`;
}

function refreshDeleteList() {
  const ids = state.dupesSelectedIds;
  let totalSize = 0;
  const items = [];
  for (const g of state.duplicates) {
    for (const it of (g.items || [])) {
      if (ids.has(it.trackId)) {
        totalSize += it.fileSize || 0;
        items.push(it);
      }
    }
  }
  $('#dupe-recoverable').textContent = fmtSize(totalSize);
  $('#dupe-selected-count').textContent = ids.size;

  const host = $('#dupe-delete-list');
  if (items.length === 0) {
    host.innerHTML = '<p class="muted">Nessun file selezionato.</p>';
  } else {
    host.innerHTML = items.map(it =>
      `<div class="delete-item">${escapeHtml(it.filePath || it.parentMixPath || '')}</div>`
    ).join('');
  }
}

function setupDupeSections() {
  $$('.dupe-section-toggle').forEach(b => {
    b.addEventListener('click', () => {
      const s = b.closest('.dupe-section');
      s.classList.toggle('collapsed');
    });
  });
}

async function applyRecommendedDupeDeletions() {
  const ids = new Set();
  for (const g of state.duplicates) {
    for (const it of (g.items || [])) {
      if (!it.recommended && it.trackId) ids.add(it.trackId);
    }
  }
  state.dupesSelectedIds = ids;
  renderDuplicates();
  pushLog({ level: 'info', icon: '✓', message: `Selezionati ${ids.size} file consigliati per eliminazione` });
}

async function exportDupeReport() {
  const lines = ['DJ Library Manager — Report doppioni', '=' .repeat(50), ''];
  for (const g of state.duplicates) {
    lines.push(`[${g.matchType}] score=${(g.similarityScore || 0).toFixed(2)} (${g.type})`);
    for (const it of g.items || []) {
      const flag = it.recommended ? '★ KEEP    ' : '  delete? ';
      lines.push(`  ${flag} ${it.filePath || ''}`);
    }
    lines.push('');
  }
  const txt = lines.join('\n');
  await window.api.copyText(txt);
  pushLog({ level: 'success', icon: '📋', message: 'Report copiato negli appunti' });
}

async function openDupeFolder() {
  // Apri la cartella del primo file selezionato
  for (const g of state.duplicates) {
    for (const it of g.items || []) {
      if (state.dupesSelectedIds.has(it.trackId) && it.filePath) {
        await window.api.openFolder(it.filePath);
        return;
      }
    }
  }
  pushLog({ level: 'warn', icon: '⚠️', message: 'Nessun file selezionato per aprire la cartella' });
}

// ============================================================================
// TAB 4: RINOMINA
// ============================================================================

async function refreshRenamePreview() {
  const r = await window.api.previewRename(state.files);
  if (!r.ok) { pushLog({ level: 'error', icon: '❌', message: `Rinomina preview: ${r.error}` }); return; }
  state.renamePreview = r.data;
  renderRenameTable();
}

function renameFilterFn(item) {
  const f = state.renameFilter;
  const t = item.track;
  const type = trackType(t);
  switch (f) {
    case 'recognized':   return !!t.isRecognized;
    case 'unrecognized': return !t.isRecognized;
    case 'check':        return t.status === 'error'
                                 || t.isRecognized === false
                                 || (item.newFileName || '').startsWith('_CHECK_');
    case 'mashup':       return type === 'mashup';
    case 'mix':          return type === 'mix';
    default:             return true;
  }
}

function renderRenameTable() {
  const body = $('#rename-tbody');
  if (state.renamePreview.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6">Nessuna anteprima — clicca "Anteprima" o completa l\'analisi.</td></tr>';
    return;
  }
  const items = state.renamePreview.filter(renameFilterFn);
  body.innerHTML = items.map(it => {
    const t = it.track;
    const type = trackType(t);
    const typeIcon = type === 'mix' ? '🎛️' : type === 'mashup' ? '🔀' : '🎵';
    const checked = state.renameSelectedIds.has(it.trackId) ? 'checked' : '';
    const stratLabel = strategyLabel(it.strategy);
    const langBadge = renderLanguageBadge(t?.vocalsLanguage);
    const baseGenreBadge = t?.detectedGenre && t?.classificationSource === 'ai_genre'
      ? `<span class="badge badge-base-genre">🎵 ${escapeHtml(String(t.detectedGenre))}</span>`
      : '';
    return `<tr>
      <td><input type="checkbox" data-rn-id="${escapeHtml(it.trackId)}" ${checked}></td>
      <td>${typeIcon}</td>
      <td class="rename-old">${escapeHtml(it.oldName)}</td>
      <td class="rename-arrow">→</td>
      <td class="rename-new">${escapeHtml(it.newFileName)}</td>
      <td>
        <span class="badge badge-strategy s-${it.strategy}">${stratLabel}</span>
        ${renderSourceBadge(it.track?.recognitionSource)}
        ${baseGenreBadge}
        ${langBadge}
        ${it.track?.classificationSource && it.track.classificationSource !== it.track?.recognitionSource
          ? renderSourceBadge(it.track.classificationSource) : ''}
      </td>
    </tr>`;
  }).join('');

  $$('input[data-rn-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.rnId;
      if (cb.checked) state.renameSelectedIds.add(id);
      else state.renameSelectedIds.delete(id);
    });
  });
}

function strategyLabel(s) {
  return ({
    'recognized':   'ACRCloud',
    'local_tags':   'Tag ID3',
    'check_prefix': 'Prefisso CHECK',
    'mix_segments': 'Segmenti Mix',
    'mix_unknown':  'Mix sconosciuto',
  })[s] || s;
}

function setupRenameFilters() {
  $$('.filter-btn').forEach(b => {
    b.addEventListener('click', () => {
      $$('.filter-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.renameFilter = b.dataset.filter;
      renderRenameTable();
    });
  });
}

async function executeRenameSelected() {
  const ids = [...state.renameSelectedIds];
  if (ids.length === 0) {
    pushLog({ level: 'warn', icon: '⚠️', message: 'Nessun file selezionato per rinomina' });
    return;
  }
  $('#confirm-rename-count').textContent = ids.length;
  showModal('confirm-rename');
}

async function confirmRename() {
  hideModal('confirm-rename');
  const ids = [...state.renameSelectedIds];
  const r = await window.api.executeRename({ tracks: state.files, selectedIds: ids, dryRun: false });
  if (!r.ok) { pushLog({ level: 'error', icon: '❌', message: `Rinomina: ${r.error}` }); return; }
  const { stats } = r.data;
  pushLog({ level: 'success', icon: '✓', message: `Rinomina: ${stats.success} ok, ${stats.failed} errori, ${stats.skipped} invariati` });
  state.renameSelectedIds.clear();
  await refreshRenamePreview();
  renderFilesTable();
}

// ============================================================================
// TAB 5: ORGANIZZA
// ============================================================================

async function maybeRefreshOrganize() {
  if (state.files.length === 0) return;
  // Per il preview ci serve il sourceFolder: usa il path del primo file
  const first = state.files[0];
  const sourceFolder = first?.filePath ? first.filePath.split(/[\\/]/).slice(0, -1).join('/') : '';
  if (!sourceFolder) return;
  const r = await window.api.previewOrganization({ tracks: state.files, sourceFolder });
  if (!r.ok) { pushLog({ level: 'error', icon: '❌', message: `Organize preview: ${r.error}` }); return; }
  state.organize.tree = r.data.tree;
  state.organize.stats = r.data.stats;
  state.organize.outputRoot = r.data.outputRoot;
  renderOrganize();
}

function renderOrganize() {
  $('#output-root-path').textContent = state.organize.outputRoot || '—';
  $('#org-files').textContent = state.organize.stats?.filesToCopy || 0;
  $('#org-size').textContent = fmtSize(state.organize.stats?.totalSizeBytes || 0);
  $('#org-folders').textContent = state.organize.stats?.foldersToCreate || 0;
  $('#org-unclassified').textContent = state.organize.stats?.unclassified || 0;

  const host = $('#organize-tree');
  if (!state.organize.tree) { host.innerHTML = '<p class="muted">Nessuna anteprima.</p>'; return; }
  host.innerHTML = renderTree(state.organize.tree);
  bindTreeToggles(host);

  $('#btn-organize-execute').disabled = !state.organize.outputRoot;

  // Aggiorna widget drive info (spazio / USB warning)
  refreshDiskInfoWidget(state.organize.outputRoot);
}

// ── Widget drive info sotto il path di output ─────────────────────────
async function refreshDiskInfoWidget(outputPath) {
  const host = $('#output-disk-info');
  if (!host) return;
  if (!outputPath) { host.innerHTML = ''; return; }
  try {
    const r = await window.api.getDiskInfo(outputPath);
    if (!r.ok) { host.innerHTML = ''; return; }
    const d = r.data || {};
    const totalSize = state.organize.stats?.totalSizeBytes || 0;
    const freeStr = d.freeBytes != null ? fmtSize(d.freeBytes) : '—';
    const totalStr = d.totalBytes != null ? fmtSize(d.totalBytes) : '—';
    const driveLabel = d.driveLetter ? `Drive ${d.driveLetter}:` : '';

    const isUsb = d.isRemovable;
    const notEnoughSpace = d.freeBytes != null && totalSize > 0 && totalSize > d.freeBytes;

    const parts = [];
    if (isUsb) {
      parts.push(`
        <div class="disk-info-row disk-info-usb">
          <span>💾</span>
          <strong>USB / Drive rimovibile</strong>
          <span class="muted">— la velocità dipende dalla pennetta</span>
        </div>`);
    }
    parts.push(`
      <div class="disk-info-row">
        <span>📊</span>
        <span>${driveLabel} spazio libero: <strong>${freeStr}</strong> / ${totalStr}</span>
        ${totalSize ? `<span class="muted">· richiesti ~${fmtSize(totalSize)}</span>` : ''}
      </div>`);
    if (notEnoughSpace) {
      parts.push(`
        <div class="disk-info-row disk-info-error">
          <span>🚫</span>
          <strong>Spazio insufficiente</strong>
          <span class="muted">— servono almeno ${fmtSize(totalSize)}, disponibili ${freeStr}</span>
        </div>`);
      $('#btn-organize-execute').disabled = true;
    }
    host.innerHTML = parts.join('');
  } catch {
    host.innerHTML = '';
  }
}

function renderTree(tree) {
  return Object.entries(tree).map(([name, val]) => {
    if (Array.isArray(val)) {
      // Cartella flat: lista tracce direttamente
      const warn = name === 'Da Classificare' ? ' has-warning' : '';
      const list = val.map(t => `<div class="tree-leaf-track">📄 ${escapeHtml(t.newFileName || t.fileName || '')}</div>`).join('');
      return `<div class="folder-tree-node collapsed${warn}" data-toggle>
        <div class="folder-line"><span class="caret-mini">▸</span><span>📁</span><span class="folder-name">${escapeHtml(name)}</span><span class="folder-count">(${val.length} file)</span></div>
        <div class="folder-children">${list}</div>
      </div>`;
    } else {
      // Cartella con subfolder
      const subs = Object.entries(val).map(([sub, tracks]) => {
        const list = tracks.map(t => `<div class="tree-leaf-track">📄 ${escapeHtml(t.newFileName || t.fileName || '')}</div>`).join('');
        return `<div class="folder-tree-node collapsed" data-toggle>
          <div class="folder-line"><span class="caret-mini">▸</span><span>📁</span><span class="folder-name">${escapeHtml(sub)}</span><span class="folder-count">(${tracks.length})</span></div>
          <div class="folder-children">${list}</div>
        </div>`;
      }).join('');
      const total = Object.values(val).reduce((a, t) => a + t.length, 0);
      return `<div class="folder-tree-node" data-toggle>
        <div class="folder-line"><span class="caret-mini">▾</span><span>📁</span><span class="folder-name">${escapeHtml(name)}</span><span class="folder-count">(${total} file)</span></div>
        <div class="folder-children">${subs}</div>
      </div>`;
    }
  }).join('');
}

function bindTreeToggles(host) {
  $$('.folder-tree-node[data-toggle] > .folder-line', host).forEach(line => {
    line.addEventListener('click', () => {
      const node = line.parentElement;
      node.classList.toggle('collapsed');
      const caret = $('.caret-mini', line);
      if (caret) caret.textContent = node.classList.contains('collapsed') ? '▸' : '▾';
    });
  });
}

async function executeOrganize() {
  if (state.files.length === 0 || !state.organize.outputRoot) return;
  const first = state.files[0];
  const sourceFolder = first?.filePath ? first.filePath.split(/[\\/]/).slice(0, -1).join('/') : '';
  $('#org-progress-wrap').style.display = '';
  $('#btn-organize-execute').disabled = true;

  const r = await window.api.executeOrganization({ tracks: state.files, sourceFolder });
  if (!r.ok) {
    pushLog({ level: 'error', icon: '❌', message: `Organizza: ${r.error}` });
    $('#btn-organize-execute').disabled = false;
    return;
  }
  state.organize.completed = true;
  state.organize.outputRoot = r.data.outputRoot;
  $('#org-completed-banner').style.display = '';
  pushLog({ level: 'success', icon: '✓', message: `Copiati ${r.data.copied} file in ${r.data.outputRoot}` });
  renderFilesTable();
}

// ============================================================================
// TAB 6: REKORDBOX
// ============================================================================

function renderRekordboxPreview() {
  renderUpdateSummary();
  const tree = state.organize.tree;
  const host = $('#rkb-playlist-preview');
  if (!tree) {
    host.innerHTML = '<p class="muted">Completa l\'organizzazione prima per vedere la struttura.</p>';
    $('#btn-generate-xml').disabled = true;
    return;
  }
  let folders = 0, playlists = 0, tracks = 0;
  const lines = [];
  for (const [name, val] of Object.entries(tree)) {
    // Struttura PIATTA: una playlist per cartella, nessuna sottocartella.
    const list = Array.isArray(val) ? val : Object.values(val).flat();
    const warn = (name === 'Da Controllare' || name === 'Da Classificare') ? ' ⚠️' : '';
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
    lines.push(`<div class="pl-folder folder-${escapeHtml(slug)}">🎵 ${escapeHtml(name)} (${list.length} tracce)${warn}</div>`);
    tracks += list.length;
    playlists++;
  }
  folders = playlists;
  host.innerHTML = lines.join('');
  $('#rkb-folders').textContent = folders;
  $('#rkb-playlists').textContent = playlists;
  $('#rkb-tracks').textContent = tracks;
  $('#btn-generate-xml').disabled = !state.organize.completed;
}

function renderUpdateSummary() {
  const host = $('#rkb-update-summary');
  if (!host) return;
  if (state.mode !== 'update' || !state.updateResult) {
    host.style.display = 'none';
    return;
  }
  const r = state.updateResult;
  host.style.display = '';
  $('#rkb-update-added').textContent = r.newTracksAdded || 0;
  $('#rkb-update-skipped').textContent = r.duplicatesFound || 0;
  $('#rkb-update-xml-status').innerHTML = r.xmlUpdated
    ? '✅ <strong>rekordbox.xml aggiornato</strong>'
    : '⚠️ <span class="muted">rekordbox.xml non aggiornato (file mancante o nessuna nuova traccia)</span>';
}

// ============================================================================
// MODALITÀ "AGGIORNA LIBRERIA ESISTENTE"
// ============================================================================

function setupModeToggle() {
  const picker = $('#existing-library-picker');
  $$('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      state.mode = radio.value;
      picker.style.display = state.mode === 'update' ? '' : 'none';
      pushLog({
        level: 'info',
        icon: state.mode === 'update' ? '➕' : '🆕',
        message: state.mode === 'update'
          ? 'Modalità: aggiungi a libreria esistente'
          : 'Modalità: nuova libreria',
      });
    });
  });

  $('#btn-pick-existing').addEventListener('click', async () => {
    const r = await window.api.selectExistingLibrary();
    if (!r.ok) {
      pushLog({ level: 'error', icon: '❌', message: r.error || 'Selezione libreria fallita' });
      return;
    }
    if (!r.data) return; // cancelled
    state.existingRoot = r.data;
    $('#existing-library-path').textContent = r.data;
    pushLog({ level: 'success', icon: '📚', message: `Libreria esistente: ${r.data}` });
  });
}

async function runUpdateAgainstExisting() {
  if (state.mode !== 'update') return;
  if (!state.existingRoot) {
    pushLog({ level: 'warn', icon: '⚠️', message: 'Seleziona prima la libreria esistente' });
    return;
  }
  if (state.files.length === 0) {
    pushLog({ level: 'warn', icon: '⚠️', message: 'Nessuna traccia da aggiungere' });
    return;
  }
  pushLog({ level: 'info', icon: '🔍', message: 'Confronto con libreria esistente...' });
  const r = await window.api.updateExisting({
    newTracks: state.files,
    existingRoot: state.existingRoot,
  });
  if (!r.ok) {
    pushLog({ level: 'error', icon: '❌', message: `Update fallito: ${r.error}` });
    return;
  }
  state.updateResult = r.data;
  pushLog({
    level: 'success',
    icon: '✅',
    message: `Update completato: +${r.data.newTracksAdded} nuove, ${r.data.duplicatesFound} già presenti`,
  });
  renderDuplicates();
  renderRekordboxPreview();
}

async function generateRekordboxXml() {
  if (!state.organize.completed || !state.organize.outputRoot) {
    pushLog({ level: 'warn', icon: '⚠️', message: 'Esegui prima l\'organizzazione' });
    return;
  }
  // Usa la nuova API che legge organizedTracks dal main appState (path post-copia)
  const r = await window.api.rekordboxGenerate();
  if (!r.ok) { pushLog({ level: 'error', icon: '❌', message: `Rekordbox: ${r.error}` }); return; }
  // L'evento 'rekordbox:xml-complete' aggiorna lo stato — qui solo log
  pushLog({ level: 'success', icon: '✅', message: `rekordbox.xml generato: ${r.data.xmlPath}` });
}

// ============================================================================
// MODALS
// ============================================================================

function showModal(name) { $(`#modal-${name}`).classList.remove('hidden'); }
function hideModal(name) { $(`#modal-${name}`).classList.add('hidden'); }

function setupModals() {
  $$('[data-close]').forEach(el => {
    el.addEventListener('click', () => hideModal(el.dataset.close));
  });
  $('#btn-open-settings').addEventListener('click', () => showModal('settings'));
}

// ============================================================================
// SETTINGS
// ============================================================================

async function loadSettings() {
  const r = await window.api.getSettings();
  if (!r.ok) return;
  state.settings = r.data;
  const acr = r.data?.acrcloud || {};
  $('#set-acr-host').value = acr.host || '';
  $('#set-acr-key').value = acr.accessKey || acr.key || '';
  $('#set-acr-secret').value = acr.accessSecret || acr.secret || '';

  // Watcher UI
  const watchFolder = r.data?.watchFolder || '';
  $('#set-watch-folder').textContent = watchFolder || '—';
  $('#set-watcher-enabled').checked = !!r.data?.watcherEnabled;
  updateWatcherStateLabel(!!r.data?.watcherEnabled && !!watchFolder);

  // Notifiche + avvio con Windows
  $('#set-notifications-enabled').checked = r.data?.notificationsEnabled !== false;
  $('#set-start-with-windows').checked = !!r.data?.startWithWindows;

  // Cartella destinazione organize
  const organizeRoot = r.data?.organizeOutputRoot || '';
  const setOrgRoot = $('#set-organize-root');
  if (setOrgRoot) setOrgRoot.textContent = organizeRoot || '(default: dentro cartella sorgente)';

  // Replicate AI token
  const replToken = r.data?.replicateToken || '';
  const setRepl = $('#set-replicate-token');
  if (setRepl) setRepl.value = replToken;
  updateReplicateStateLabel(!!replToken);

  // AcoustID key
  const acoustidKey = r.data?.acoustidKey || '';
  const setAid = $('#set-acoustid-key');
  if (setAid) setAid.value = acoustidKey;
  updateAcoustidStateLabel(!!acoustidKey);

  // Concorrenza analisi
  const c = Number(r.data?.analysisConcurrency || 3);
  const cSlider = $('#set-concurrency');
  const cVal = $('#set-concurrency-value');
  if (cSlider) cSlider.value = String(c);
  if (cVal) cVal.textContent = String(c);
}

function updateReplicateStateLabel(configured, valid = null) {
  const el = $('#set-replicate-state');
  if (!el) return;
  if (valid === true)  { el.textContent = '🟢 Attivo'; el.classList.add('active'); el.classList.remove('inactive'); return; }
  if (valid === false) { el.textContent = '🔴 Token non valido'; el.classList.remove('active'); el.classList.add('inactive'); return; }
  el.textContent = configured ? '🟡 Da verificare' : '🔴 Non configurato';
  el.classList.toggle('active', false);
  el.classList.toggle('inactive', true);
}

async function testReplicateConnection() {
  const tokenInput = $('#set-replicate-token');
  const token = tokenInput?.value?.trim() || null;
  const el = $('#set-replicate-state');
  if (el) el.textContent = '⏳ Verifica...';
  const r = await window.api.testReplicate?.(token);
  if (r?.ok && r.data?.ok) updateReplicateStateLabel(true, true);
  else updateReplicateStateLabel(!!token, false);
}

function updateAcoustidStateLabel(configured, valid = null) {
  const el = $('#set-acoustid-state');
  if (!el) return;
  if (valid === true) {
    el.textContent = '🟢 Attiva — riconoscimento illimitato disponibile';
    el.classList.add('active'); el.classList.remove('inactive');
    return;
  }
  if (valid === false) {
    el.textContent = '🔴 Chiave non valida';
    el.classList.remove('active'); el.classList.add('inactive');
    return;
  }
  el.textContent = configured
    ? '🟡 Da verificare'
    : '🔴 Non configurata — MusicBrainz fallback disabilitato';
  el.classList.toggle('active', false);
  el.classList.toggle('inactive', true);
}

async function testAcoustidConnection() {
  const input = $('#set-acoustid-key');
  const key = input?.value?.trim() || '';
  const el = $('#set-acoustid-state');
  if (el) el.textContent = '⏳ Verifica...';
  const r = await window.api.testAcoustid?.(key);
  // r viene dal handler direttamente: { ok, message }
  if (r?.ok) {
    if (el && r.message) el.textContent = r.message;
    updateAcoustidStateLabel(true, true);
  } else {
    if (el && r?.message) el.textContent = r.message;
    updateAcoustidStateLabel(!!key, false);
  }
}

async function pickOrganizeOutputRoot() {
  const r = await window.api.selectFolder();
  if (!r.ok || !r.data) return;
  const setOrg = $('#set-organize-root');
  if (setOrg) setOrg.textContent = r.data;
  const pathEl = $('#output-root-path');
  if (pathEl) pathEl.textContent = r.data;
  await window.api.setSettings({ organizeOutputRoot: r.data });
  pushLog({ level: 'info', icon: '📁', message: `Destinazione organize: ${r.data}` });
  // Se siamo nel tab organizza, refresh preview
  if (state.analysisDone) await maybeRefreshOrganize();
}

async function resetOrganizeOutputRoot() {
  await window.api.setSettings({ organizeOutputRoot: '' });
  const setOrg = $('#set-organize-root');
  if (setOrg) setOrg.textContent = '(default: dentro cartella sorgente)';
  pushLog({ level: 'info', icon: '📁', message: 'Destinazione organize: default' });
  if (state.analysisDone) await maybeRefreshOrganize();
}

function updateWatcherStateLabel(active) {
  const el = $('#set-watcher-state-label');
  if (!el) return;
  el.textContent = active ? '🟢 In ascolto' : '🔴 Non attivo';
  el.classList.toggle('active', active);
  el.classList.toggle('inactive', !active);
}

async function saveSettings() {
  const payload = {
    acrcloud: {
      host: $('#set-acr-host').value.trim(),
      accessKey: $('#set-acr-key').value.trim(),
      accessSecret: $('#set-acr-secret').value.trim(),
    },
    notificationsEnabled: $('#set-notifications-enabled').checked,
    startWithWindows: $('#set-start-with-windows').checked,
    replicateToken: $('#set-replicate-token')?.value?.trim() || '',
    acoustidKey: $('#set-acoustid-key')?.value?.trim() || '',
    analysisConcurrency: Number($('#set-concurrency')?.value) || 3,
  };
  const r = await window.api.setSettings(payload);
  if (!r.ok) { pushLog({ level: 'error', icon: '❌', message: `Settings: ${r.error}` }); return; }
  pushLog({ level: 'success', icon: '✓', message: 'Impostazioni salvate' });
  hideModal('settings');
  await refreshApiStatus();
}

async function pickWatchFolder() {
  const r = await window.api.selectFolder();
  if (!r.ok || !r.data) return;
  $('#set-watch-folder').textContent = r.data;
  await window.api.setSettings({ watchFolder: r.data });
  // Se il watcher è acceso, riavvia sul nuovo path
  if ($('#set-watcher-enabled').checked) {
    await window.api.watcherStop?.();
    await window.api.watcherStart?.({ folder: r.data });
  }
}

async function toggleWatcher(checked) {
  const folder = $('#set-watch-folder').textContent.trim();
  if (checked) {
    if (!folder || folder === '—') {
      pushLog({ level: 'warn', icon: '⚠️', message: 'Seleziona prima una cartella da monitorare' });
      $('#set-watcher-enabled').checked = false;
      return;
    }
    const r = await window.api.watcherStart?.({ folder });
    if (!r?.ok) {
      pushLog({ level: 'error', icon: '❌', message: `Watcher: ${r?.error || 'errore avvio'}` });
      $('#set-watcher-enabled').checked = false;
      return;
    }
    await window.api.setSettings({ watcherEnabled: true });
    updateWatcherStateLabel(true);
    pushLog({ level: 'success', icon: '👁️', message: `Watcher attivo su ${folder}` });
  } else {
    await window.api.watcherStop?.();
    await window.api.setSettings({ watcherEnabled: false });
    updateWatcherStateLabel(false);
    pushLog({ level: 'info', icon: '🛑', message: 'Watcher fermato' });
  }
}

async function testApiConnection() {
  $('#api-test-result').textContent = '⏳ Test in corso...';
  const r = await window.api.testApi();
  const online = !!(r.ok && r.data?.online);
  $('#api-test-result').textContent = online ? '✓ Connesso' : `✗ ${r.data?.reason || 'Errore'}`;
  await refreshApiStatus();
}

async function testShazamConnection() {
  const el = $('#set-shazam-state');
  if (!el) return;
  el.textContent = '⏳ Verifica...';
  el.classList.remove('active', 'inactive');
  const r = await window.api.testShazam?.();
  if (r?.ok && r.data?.ok) {
    el.textContent = '🟢 Disponibile';
    el.classList.add('active');
  } else {
    el.textContent = `🔴 ${r?.data?.message || r?.error || 'Non disponibile'}`;
    el.classList.add('inactive');
  }
}

function setupSettingsSliders() {
  const dThr = $('#set-dupe-threshold');
  const dVal = $('#set-dupe-value');
  dThr.addEventListener('input', () => { dVal.textContent = `${dThr.value}%`; });
  const mMin = $('#set-mix-min');
  const mVal = $('#set-mix-value');
  mMin.addEventListener('input', () => { mVal.textContent = `${mMin.value} min`; });
  const cSlider = $('#set-concurrency');
  const cVal = $('#set-concurrency-value');
  if (cSlider && cVal) {
    cSlider.addEventListener('input', () => { cVal.textContent = cSlider.value; });
  }
}

// ============================================================================
// IPC EVENT LISTENERS (push da main)
// ============================================================================

function setupIpcEvents() {
  window.api.onProgress((p) => {
    if (p.phase === 'rename' || p.phase === 'organize') {
      if (p.phase === 'organize') {
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        const bar = $('#org-progress-bar');
        if (bar) bar.style.width = `${pct}%`;
        const lbl = $('#org-progress-label');
        if (lbl) lbl.textContent = `${p.done} / ${p.total} — ${p.current || ''}`;
      }
      return;
    }
    setProgress(p.done || 0, p.total || 0, p.label, p.current);
  });

  window.api.onLog((entry) => pushLog(entry));

  // ── Nuovi push events della pipeline strutturata ───────────────────
  window.api.onAnalysisProgress((p) => {
    // p: {phase, totalPhases, phaseProgress, phaseLabel, currentFile, overallPercent}
    const bar = $('#analysis-progress-bar');
    if (bar) bar.style.width = `${p.overallPercent}%`;
    const pctEl = $('#progress-pct');
    if (pctEl) pctEl.textContent = `${p.overallPercent}%`;
    const phaseEl = $('#phase-label');
    if (phaseEl) {
      const lbl = `Fase ${p.phase} di ${p.totalPhases} — ${p.phaseLabel}`;
      phaseEl.textContent = p.currentFile ? `${lbl} — ${p.currentFile}` : lbl;
    }
    // ETA approssimativa
    if (state.analysis.startedAt && p.overallPercent > 0) {
      const elapsed = Date.now() - state.analysis.startedAt;
      const totalEst = (elapsed / p.overallPercent) * 100;
      const remaining = Math.max(0, totalEst - elapsed);
      $('#progress-eta').textContent = remaining > 1000 ? `~${formatElapsed(remaining)} rimasti` : '';
    }
  });

  window.api.onAnalysisComplete((payload) => {
    // payload: {tracks, duplicateReport, crossMixDuplicates, renamePreview, organizePreview, rekordboxPreview}
    state.files = payload.tracks || state.files;
    state.duplicates = payload.duplicateReport || [];
    state.crossMixDuplicates = payload.crossMixDuplicates || [];
    state.renamePreview = payload.renamePreview || [];
    if (payload.organizePreview) {
      state.organize.tree = payload.organizePreview.tree;
      state.organize.stats = payload.organizePreview.stats;
      state.organize.outputRoot = payload.organizePreview.outputRoot;
    }
    renderFilesTable();
    renderDuplicates();
    renderRenameTable();
    renderOrganize();
    renderRekordboxPreview();
    refreshAnalysisStats();
    $('#phase-label').textContent = '✓ Analisi completata';
    pushLog({ level: 'success', icon: '✅', message: 'Pipeline completata — tutti i tab aggiornati' });
    // Sblocca i tab gated
    state.analysisDone = true;
    state.analysisRunning = false;
    updateTabsGating();
  });

  // Cross-mix duplicates: arriva separato dopo analysis:complete
  window.api.onCrossMixDuplicates?.((payload) => {
    state.crossMixDuplicates = payload?.duplicates || [];
    renderDuplicates();
  });

  window.api.onOrganizeComplete((payload) => {
    // payload: {outputRoot, stats}
    state.organize.completed = true;
    state.organize.outputRoot = payload.outputRoot;
    $('#org-completed-banner').style.display = '';
    renderFilesTable();
    pushLog({ level: 'success', icon: '✓', message: `Organizzazione completata: ${payload.outputRoot}` });
  });

  window.api.onRekordboxComplete((payload) => {
    // payload: {xmlPath, stats}
    state.rekordbox.xmlPath = payload.xmlPath;
    $('#xml-path-display').textContent = payload.xmlPath;
    $('#rkb-instructions').style.display = '';
  });
}

// ============================================================================
// BOOTSTRAP
// ============================================================================

async function init() {
  // Tabs
  $$('.tab-btn').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  // Stato iniziale: analisi non ancora fatta → tab gated disabilitati
  updateTabsGating();

  // Tab 1
  $('#btn-select-folder').addEventListener('click', loadFolder);
  $('#btn-select-files').addEventListener('click', loadFiles);
  $('#btn-start-analysis').addEventListener('click', startAnalysis);
  setupDropZone();
  setupModeToggle();

  // Tab 2
  $('#btn-clear-log').addEventListener('click', () => { state.logs = []; renderLog(); });

  // Tab 3
  setupDupeSections();
  $('#btn-apply-recommendations').addEventListener('click', applyRecommendedDupeDeletions);
  $('#btn-export-dupe-report').addEventListener('click', exportDupeReport);
  $('#btn-open-dupe-folder').addEventListener('click', openDupeFolder);

  // Tab 4
  setupRenameFilters();
  $('#btn-rename-preview').addEventListener('click', refreshRenamePreview);
  $('#btn-rename-select-all').addEventListener('click', () => {
    const items = state.renamePreview.filter(renameFilterFn);
    state.renameSelectedIds = new Set(items.filter(i => i.canRename).map(i => i.trackId));
    renderRenameTable();
  });
  $('#btn-rename-execute').addEventListener('click', executeRenameSelected);
  $('#btn-confirm-rename').addEventListener('click', confirmRename);
  $('#rename-select-all').addEventListener('change', (e) => {
    const items = state.renamePreview.filter(renameFilterFn);
    if (e.target.checked) {
      state.renameSelectedIds = new Set(items.map(i => i.trackId));
    } else {
      state.renameSelectedIds.clear();
    }
    renderRenameTable();
  });

  // Tab 5
  $('#btn-organize-execute').addEventListener('click', executeOrganize);
  $('#btn-goto-rekordbox').addEventListener('click', () => switchTab('rekordbox'));
  $('#btn-pick-output-root')?.addEventListener('click', pickOrganizeOutputRoot);
  $('#btn-reset-output-root')?.addEventListener('click', resetOrganizeOutputRoot);
  $('#btn-set-organize-root')?.addEventListener('click', pickOrganizeOutputRoot);

  // Tab 6
  $('#btn-generate-xml').addEventListener('click', generateRekordboxXml);
  $('#btn-open-output').addEventListener('click', () => {
    if (state.organize.outputRoot) window.api.openFolder(state.organize.outputRoot);
  });
  $('#btn-copy-xml-path').addEventListener('click', async () => {
    if (state.rekordbox.xmlPath) {
      await window.api.copyText(state.rekordbox.xmlPath);
      pushLog({ level: 'success', icon: '📋', message: 'Percorso copiato negli appunti' });
    }
  });
  $('#btn-toggle-rkb-details')?.addEventListener('click', () => {
    const el = $('#rkb-full-details');
    if (!el) return;
    el.style.display = el.style.display === 'none' ? '' : 'none';
  });

  // Modals + settings
  setupModals();
  setupSettingsSliders();
  $('#btn-save-settings').addEventListener('click', saveSettings);
  $('#btn-test-api').addEventListener('click', testApiConnection);
  $('#btn-test-shazam')?.addEventListener('click', testShazamConnection);
  $('#btn-test-replicate')?.addEventListener('click', testReplicateConnection);
  $('#lnk-replicate')?.addEventListener('click', (e) => {
    e.preventDefault();
    // shell.openExternal via preload se esiste; altrimenti window.open
    if (window.api.openExternal) window.api.openExternal('https://replicate.com/account/api-tokens');
    else window.open('https://replicate.com/account/api-tokens', '_blank');
  });
  $('#btn-test-acoustid')?.addEventListener('click', testAcoustidConnection);
  $('#lnk-acoustid')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (window.api.openExternal) window.api.openExternal('https://acoustid.org/login');
    else window.open('https://acoustid.org/login', '_blank');
  });
  $('#set-acoustid-key')?.addEventListener('input', () => {
    const k = $('#set-acoustid-key').value?.trim();
    updateAcoustidStateLabel(!!k);
  });

  // IPC events
  setupIpcEvents();

  // Watcher status polling (ogni 5s)
  const refreshWatcher = async () => {
    try {
      const r = await window.api.watcherStatus?.();
      const active = !!(r?.ok && r.data?.active);
      const dot = $('#watcher-dot');
      const lbl = $('#watcher-label');
      if (dot) dot.classList.toggle('inactive', !active);
      if (lbl) lbl.textContent = active
        ? `Watcher attivo${r.data?.folder ? ' · ' + r.data.folder.split(/[\\/]/).pop() : ''}`
        : 'Watcher non attivo';
    } catch { /* noop */ }
  };
  refreshWatcher();
  setInterval(refreshWatcher, 5000);

  // Help button → modal help dedicato
  $('#btn-help')?.addEventListener('click', () => showModal('help'));

  // Watcher UI wiring
  $('#btn-pick-watch-folder')?.addEventListener('click', pickWatchFolder);
  $('#set-watcher-enabled')?.addEventListener('change', (e) => toggleWatcher(e.target.checked));

  // Final result modal actions
  $('#fr-goto-dupes')?.addEventListener('click', () => {
    hideModal('final-result');
    switchTab('doppioni');
  });
  $('#fr-open-folder')?.addEventListener('click', () => {
    if (state.organize.outputRoot) window.api.openFolder(state.organize.outputRoot);
  });

  // Auto-updater banner wiring
  setupUpdateBanner();

  // Boot async
  await loadSettings();
  await refreshApiStatus();
}

// ─────────────────────────────────────────────────────────────────
// Auto-updater banner
// ─────────────────────────────────────────────────────────────────
function setupUpdateBanner() {
  const banner = document.getElementById('update-banner');
  const msg = document.getElementById('update-message');
  const wrap = document.getElementById('update-progress-wrap');
  const bar = document.getElementById('update-progress-bar');
  const btnInstall = document.getElementById('btn-install-now');
  const btnDismiss = document.getElementById('btn-dismiss-update');
  if (!banner || !msg) return;

  window.api.onUpdateAvailable(({ version, message }) => {
    msg.textContent = `⬇️ ${message || `Versione ${version} in download`}`;
    banner.style.display = 'flex';
    if (wrap) wrap.style.display = 'block';
    if (bar) bar.style.width = '0%';
    if (btnInstall) btnInstall.style.display = 'none';
  });

  window.api.onUpdateDownload(({ percent }) => {
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
  });

  window.api.onUpdateReady(({ version }) => {
    msg.textContent = `✅ Versione ${version} pronta!`;
    if (wrap) wrap.style.display = 'none';
    if (btnInstall) btnInstall.style.display = 'inline-flex';
    banner.style.display = 'flex';
  });

  if (btnInstall) {
    btnInstall.addEventListener('click', () => {
      try { window.api.updateInstallNow(); } catch { /* noop */ }
    });
  }
  if (btnDismiss) {
    btnDismiss.addEventListener('click', () => { banner.style.display = 'none'; });
  }
}

document.addEventListener('DOMContentLoaded', init);
