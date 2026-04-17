/**
 * src/services/renameService.js
 *
 * Generazione + esecuzione rinomine file secondo regole DJ Library Manager.
 *
 * FORMATI:
 *   single recognized:  "Artista - Titolo (BPM).mp3"            es. "Bad Bunny - Titi Me Pregunto (102).mp3"
 *   single local_tags:  idem ma da tag ID3 locali
 *   single check:       "_CHECK_ <oldName>"                     (no BPM, da revisionare)
 *   mashup recognized:  "A1 x A2 - Titolo (EditType) (BPM).mp3" es. "Bad Bunny x J Balvin - Titi (Afrohouse Edit) (102).mp3"
 *   mashup check:       "_CHECK_ <oldName>"
 *   mix segments:       "A1 - T1 - A2 - T2 - A3 - T3.mp3"       (separator " - ", NO BPM)
 *                       > 5 tracce → top 5 + " (+ N tracce)"
 *                       > 200 char → top 3 + " (+ N tracce)"
 *   mix unknown:        "_MIX_ <oldName>"
 *
 * BPM:
 *   formatBpm(track) → " (98)" oppure ""
 *   Fonte: track.bpm > track.recognizedBpm > nulla
 *   Mai (0)/(null)/(undefined). Mai BPM nei mix né nei _CHECK_.
 *
 * Lunghezze:
 *   - core (Artist - Title o Artist x ... - Title (Edit)): max 120 char
 *   - poi si appende suffisso BPM + estensione (non contati nei 120)
 *   - mix: cap 200 totale (incl. " (+N tracce)" e ext)
 *
 * Backup:
 *   prima del rename fisico scrive nel tag ID3 comment (solo .mp3):
 *   "DJLM_ORIGINAL: <oldName> | DATE: YYYY-MM-DD"
 *
 * Esporta (spec):
 *   formatBpm, generateNewFileName, previewRenames, executeRename, executeRenameAll
 * Esporta (retro-compat):
 *   renameSingle, renameMashup, renameMix, buildNewPath
 *
 * Dipendenze: path, fs, node-id3, stringUtils
 */

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const NodeID3 = require('node-id3');

const { sanitizeFileName, isMashupOrEdit } = require('../utils/stringUtils');
const { CONFIG } = require('../constants/CONFIG');

// ---------------------------------------------------------------------------
// Costanti
// ---------------------------------------------------------------------------

const MIX_SEPARATOR = ' \u00B7 ';  // " · " (middle dot U+00B7) per separare artisti nel mix
const MIX_MAX_ARTISTS = 4;         // max artisti nel nome, poi " · ..."
const MAX_CORE_LEN = 120;          // cap "Artist - Title" escluso BPM + ext
const MAX_MIX_TOTAL = 200;         // cap totale nome mix incluso suffisso
const CHECK_PREFIX = '_CHECK_ ';
const MIX_UNKNOWN_PREFIX = '_MIX_ ';
const MIN_SEG_CONFIDENCE = CONFIG.recognition?.minConfidence ?? 65;

// ---------------------------------------------------------------------------
// Helpers interni
// ---------------------------------------------------------------------------

function extOf(p) { return path.extname(p) || '.mp3'; }

function hasUsableLocalTags(track) {
  const t = String(track?.localTitle || '').trim();
  const a = String(track?.localArtist || '').trim();
  return !!(t && a);
}

/**
 * Estrae il "tipo di edit" dalla stringa originale (parens contenenti
 * keyword tipiche). Ritorna la stringa interna alla parentesi (es.
 * "Afrohouse Edit", "Tech House Blend") oppure '' se non trovato.
 */
function extractEditType(title = '') {
  if (!title) return '';
  const kw = /(mashup|edit|bootleg|blend|version|remix|extended|tribal|afrohouse|tech\s*house|instrumental|acapella|acappella|transition)/i;
  const patterns = [/\(([^)]+)\)/g, /\[([^\]]+)\]/g];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(title)) !== null) {
      const inner = m[1].trim();
      if (kw.test(inner)) return inner;
    }
  }
  return '';
}

/** Rimuove dal titolo i marker di edit (già preservati separatamente). */
function stripEditAnnotations(title = '') {
  const kwGroup = '(?:mashup|edit|bootleg|blend|version|remix|extended|tribal|afrohouse|tech\\s*house|instrumental|acapella|acappella|transition)';
  return String(title)
    .replace(new RegExp(`\\s*\\([^)]*${kwGroup}[^)]*\\)`, 'gi'), '')
    .replace(new RegExp(`\\s*\\[[^\\]]*${kwGroup}[^\\]]*\\]`, 'gi'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splitta una stringa con più artisti (commas, &, x, vs, feat, ft) e
 * ricompone nel formato spec "A1 x A2 x A3".
 */
function splitArtistsForMashup(artistStr = '') {
  if (!artistStr) return '';
  const parts = String(artistStr)
    .split(/\s*(?:,|&|\sx\s|\svs\.?\s|\sfeat\.?\s|\sft\.?\s)\s*/i)
    .map(s => s.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts.join(' x ') : (parts[0] || '');
}

/**
 * Cap "core" a MAX_CORE_LEN preservando il suffisso "(EditType)" se presente
 * (così non lo tronchiamo a metà).
 */
function capCore(core, maxLen = MAX_CORE_LEN) {
  if (core.length <= maxLen) return core;
  // Se finisce con "(...)" lo isoliamo e tronchiamo solo la parte prima
  const m = core.match(/^(.*?)(\s*\([^)]+\))$/);
  if (m) {
    const head = m[1];
    const tail = m[2];
    const headMax = maxLen - tail.length;
    if (headMax > 0) return head.slice(0, headMax).trim() + tail;
  }
  return core.slice(0, maxLen).trim();
}

/**
 * Costruisce il nome mix nel formato "Art1 · Art2 · Art3 (BPM medio)".
 * Elenca gli artisti UNICI dei segmenti riconosciuti, max 4, poi " · ..."
 * se ce ne sono altri. Il BPM è la media (arrotondata) dei BPM presenti.
 *
 * @param {Array} segments - MixSegment[]
 * @param {string} ext     - ".mp3" etc.
 * @param {number|null} avgBpm - BPM medio opzionale (già calcolato)
 */
function buildMixCore(segments, ext, avgBpm = null) {
  const segs = (segments || []).filter(s => s && (s.artist || s.title));
  if (segs.length === 0) return null;

  // Artisti unici preservando ordine di apparizione
  const seen = new Set();
  const uniqueArtists = [];
  for (const s of segs) {
    const a = String(s.artist || '').trim();
    if (!a) continue;
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueArtists.push(sanitizeFileName(a));
  }
  if (uniqueArtists.length === 0) return null;

  let selected = uniqueArtists;
  let suffix = '';
  if (uniqueArtists.length > MIX_MAX_ARTISTS) {
    selected = uniqueArtists.slice(0, MIX_MAX_ARTISTS);
    suffix = `${MIX_SEPARATOR}...`;
  }

  const bpmSuffix = (avgBpm && avgBpm > 0) ? ` (${Math.round(avgBpm)})` : '';
  let name = selected.join(MIX_SEPARATOR) + suffix + bpmSuffix;

  // Cap a 200 char (incluso ext): riduci a 3 artisti se ancora lungo
  if ((name + ext).length > MAX_MIX_TOTAL) {
    selected = uniqueArtists.slice(0, 3);
    suffix = uniqueArtists.length > 3 ? `${MIX_SEPARATOR}...` : '';
    name = selected.join(MIX_SEPARATOR) + suffix + bpmSuffix;
    if ((name + ext).length > MAX_MIX_TOTAL) {
      const max = MAX_MIX_TOTAL - ext.length - suffix.length - bpmSuffix.length - 1;
      name = (selected.join(MIX_SEPARATOR)).slice(0, Math.max(1, max)).trim() + suffix + bpmSuffix;
    }
  }
  return name;
}

/**
 * Media BPM dei segmenti (BPM noti). null se nessuno.
 */
function mixAverageBpm(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const nums = segments
    .map(s => Number(s?.bpm))
    .filter(n => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ---------------------------------------------------------------------------
// formatBpm + formatBpmKey
// ---------------------------------------------------------------------------

/**
 * Legacy: solo BPM. Mantenuta per retro-compat.
 */
function formatBpm(track) {
  const bpm = track?.bpm || track?.recognizedBpm;
  if (!bpm || bpm <= 0) return '';
  return ` (${Math.round(bpm)})`;
}

/**
 * Nuovo formato: " (BPM KEY)" | " (BPM)" | " (KEY)" | ""
 * Esempi:
 *   bpm=98, key="8B"  → " (98 8B)"
 *   bpm=120, key=null → " (120)"
 *   bpm=null, key="4A" → " (4A)"
 *   nulla → ""
 */
function formatBpmKey(track) {
  const bpmRaw = track?.bpm || track?.recognizedBpm;
  const bpm = (bpmRaw && Number(bpmRaw) > 0) ? Math.round(Number(bpmRaw)) : null;
  const key = track?.key ? String(track.key).trim() : null;
  if (bpm && key) return ` (${bpm} ${key})`;
  if (bpm)        return ` (${bpm})`;
  if (key)        return ` (${key})`;
  return '';
}

// ---------------------------------------------------------------------------
// generateNewFileName (spec)
// ---------------------------------------------------------------------------

/**
 * @param {Track} track
 * @returns {{newFileName:string, strategy:string, canRename:boolean, reason:string, hasBpm:boolean}}
 */
function generateNewFileName(track) {
  if (process.env.DJLM_DEBUG_RENAME) {
    console.log('[RENAME DEBUG]', {
      file: track?.fileName,
      bpm: track?.bpm,
      recognizedBpm: track?.recognizedBpm,
      key: track?.key,
      formatBpmResult: formatBpm(track),
      formatBpmKeyResult: formatBpmKey(track),
    });
  }
  const oldName = track?.fileName || (track?.filePath ? path.basename(track.filePath) : '');
  const ext = extOf(oldName || '.mp3');
  const type = track?.type || (track?.isMix ? 'mix' : (track?.isMashup ? 'mashup' : 'single'));

  // ── MIX ───────────────────────────────────────────────────────────────
  if (type === 'mix' || track?.isMix) {
    const validSegs = (track?.mixSegments || [])
      .filter(s => s && (s.confidence == null || s.confidence >= MIN_SEG_CONFIDENCE));
    if (validSegs.length > 0) {
      // BPM medio: segmenti con BPM oppure fallback al BPM della traccia
      const avgBpm = mixAverageBpm(validSegs)
        ?? (track?.bpm && Number(track.bpm) > 0 ? Number(track.bpm) : null);
      const core = buildMixCore(validSegs, ext, avgBpm);
      if (core) {
        return {
          newFileName: core + ext,
          strategy: 'mix_segments',
          canRename: true,
          reason: `Mix con ${validSegs.length} segmenti riconosciuti`,
          hasBpm: !!avgBpm,
        };
      }
    }
    return {
      newFileName: sanitizeFileName(MIX_UNKNOWN_PREFIX + path.basename(oldName, ext)) + ext,
      strategy: 'mix_unknown',
      canRename: false,
      reason: 'Mix senza segmenti riconosciuti. Serve revisione manuale.',
      hasBpm: false,
    };
  }

  // ── SINGLE / MASHUP ───────────────────────────────────────────────────
  const isMashup = type === 'mashup' || track?.isMashup || isMashupOrEdit(track?.localTitle);
  const bpmSuffix = formatBpmKey(track);
  const hasBpm = !!(track?.bpm && Number(track.bpm) > 0);
  const hasKey = !!(track?.key);

  // 1) Recognized
  if (track?.isRecognized && track.recognizedTitle && track.recognizedArtist) {
    const editType = isMashup ? (extractEditType(track.localTitle) || 'Edit') : '';
    const artist = isMashup
      ? splitArtistsForMashup(track.recognizedArtist)
      : track.recognizedArtist;
    const cleanTitle = stripEditAnnotations(track.recognizedTitle) || track.recognizedTitle;

    let core = `${sanitizeFileName(artist || 'Unknown Artist')} - ${sanitizeFileName(cleanTitle || 'Unknown')}`;
    if (editType) core += ` (${sanitizeFileName(editType)})`;
    core = capCore(core);

    return {
      newFileName: core + bpmSuffix + ext,
      strategy: 'recognized',
      canRename: true,
      reason: isMashup
        ? `ACRCloud (confidence ${track.recognitionConfidence || 0}), edit preservato`
        : `ACRCloud (confidence ${track.recognitionConfidence || 0})`,
      hasBpm, hasKey,
    };
  }

  // 2) Local tags
  if (hasUsableLocalTags(track)) {
    const editType = isMashup ? (extractEditType(track.localTitle) || 'Edit') : '';
    const artist = isMashup
      ? splitArtistsForMashup(track.localArtist)
      : track.localArtist;
    const cleanTitle = stripEditAnnotations(track.localTitle) || track.localTitle;

    let core = `${sanitizeFileName(artist || 'Unknown Artist')} - ${sanitizeFileName(cleanTitle || 'Unknown')}`;
    if (editType) core += ` (${sanitizeFileName(editType)})`;
    core = capCore(core);

    return {
      newFileName: core + bpmSuffix + ext,
      strategy: 'local_tags',
      canRename: true,
      reason: 'Tag ID3 locali sufficienti',
      hasBpm, hasKey,
    };
  }

  // 2b) Mashup NON riconosciuto ma con keyword nel nome e almeno un artista locale
  //    → "Art1 x Art2 - (BPM KEY).mp3" (almeno BPM/chiave se disponibili)
  if (isMashup && (bpmSuffix || String(track?.localArtist || '').trim())) {
    const artistStr = String(track?.localArtist || '').trim();
    if (artistStr) {
      const artists = splitArtistsForMashup(artistStr);
      const editType = extractEditType(track?.localTitle) || '';
      let core = `${sanitizeFileName(artists)} -`;
      if (editType) core += ` (${sanitizeFileName(editType)})`;
      core = capCore(core);
      return {
        newFileName: core + bpmSuffix + ext,
        strategy: 'mashup_hint',
        canRename: !!bpmSuffix,
        reason: 'Mashup non riconosciuto ma artisti e BPM/Chiave sufficienti',
        hasBpm, hasKey,
      };
    }
  }

  // 3) Check prefix (no BPM)
  const baseOld = path.basename(oldName, ext) || 'untitled';
  return {
    newFileName: sanitizeFileName(CHECK_PREFIX + baseOld) + ext,
    strategy: 'check_prefix',
    canRename: false,
    reason: 'Nessun tag ID3 utilizzabile né riconoscimento. Controllo manuale richiesto.',
    hasBpm: false, hasKey: false,
  };
}

// ---------------------------------------------------------------------------
// previewRenames (spec)
// ---------------------------------------------------------------------------

async function previewRenames(tracks) {
  return (tracks || []).map(t => {
    const res = generateNewFileName(t);
    const oldName = t?.fileName || (t?.filePath ? path.basename(t.filePath) : '');
    return {
      track: t,
      trackId: t?.id || null,
      oldName,
      newFileName: res.newFileName,
      strategy: res.strategy,
      canRename: res.canRename,
      reason: res.reason,
      hasBpm: res.hasBpm,
      unchanged: oldName === res.newFileName,
    };
  });
}

// ---------------------------------------------------------------------------
// ID3 backup
// ---------------------------------------------------------------------------

function writeOriginalNameBackup(filePath, originalFileName) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.mp3') {
    return { ok: false, skipped: true, reason: `backup ID3 non supportato per ${ext}` };
  }
  try {
    const date = new Date().toISOString().slice(0, 10);
    const text = `DJLM_ORIGINAL: ${originalFileName} | DATE: ${date}`;
    const ok = NodeID3.update({
      comment: { language: 'eng', shortText: 'DJLM', text },
    }, filePath);
    return { ok: !!ok };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// fs.rename con fallback EXDEV (in-place: solitamente non serve)
// ---------------------------------------------------------------------------

async function renamePhysical(oldPath, newPath) {
  try {
    await fsp.rename(oldPath, newPath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(oldPath, newPath);
      await fsp.unlink(oldPath).catch(() => {});
    } else {
      throw err;
    }
  }
}

async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/** Risolve collisioni: "Name.mp3" → "Name (1).mp3", ... */
async function uniqueTarget(targetPath) {
  if (!await pathExists(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let i = 1; i < 1000; i++) {
    const cand = path.join(dir, `${base} (${i})${ext}`);
    if (!(await pathExists(cand))) return cand;
  }
  return targetPath; // fallback (improbabile)
}

// ---------------------------------------------------------------------------
// executeRename (spec)
// ---------------------------------------------------------------------------

/**
 * @param {Track} track
 * @param {boolean} dryRun
 * @returns {Promise<{success, oldPath, newPath, error?, warning?, strategy?}>}
 *
 * NOTA: NON aggiorna track.filePath (verrà sincronizzato dall'organizer
 * dopo l'eventuale copia). Aggiorna solo:
 *   - track.newFileName
 *   - track.fileName        (nome corrente in dir)
 *   - track.originalFileName (solo se non già impostato)
 *   - track.status = 'renamed'
 */
async function executeRename(track, dryRun = false) {
  const oldPath = track?.filePath;
  if (!oldPath) {
    return { success: false, oldPath: '', newPath: '', error: 'filePath mancante sul track' };
  }

  const decision = generateNewFileName(track);
  const dir = path.dirname(oldPath);
  const desiredPath = path.join(dir, decision.newFileName);

  if (desiredPath === oldPath) {
    return {
      success: true, oldPath, newPath: oldPath,
      strategy: decision.strategy, warning: 'name invariato',
    };
  }

  let finalPath = desiredPath;
  try {
    finalPath = await uniqueTarget(desiredPath);
  } catch { /* uniqueTarget non deve fallire; fallback: usa desiredPath */ }

  if (dryRun) {
    return { success: true, oldPath, newPath: finalPath, strategy: decision.strategy };
  }

  // 1) Backup ID3 (sul vecchio path, prima di renamare)
  const origName = track.originalFileName || track.fileName || path.basename(oldPath);
  const backup = writeOriginalNameBackup(oldPath, origName);

  // 2) Rename fisico
  try {
    await renamePhysical(oldPath, finalPath);
  } catch (err) {
    return {
      success: false, oldPath, newPath: finalPath,
      error: err.message, strategy: decision.strategy,
    };
  }

  // 3) Aggiorna Track (NO filePath — spec)
  if (!track.originalFileName) track.originalFileName = origName;
  track.newFileName = path.basename(finalPath);
  track.fileName = path.basename(finalPath);
  track.status = 'renamed';

  return {
    success: true,
    oldPath,
    newPath: finalPath,
    strategy: decision.strategy,
    warning: backup.skipped
      ? backup.reason
      : (backup.ok ? undefined : `backup ID3 fallito: ${backup.error || 'unknown'}`),
  };
}

// ---------------------------------------------------------------------------
// executeRenameAll (spec)
// ---------------------------------------------------------------------------

/**
 * @param {Track[]} tracks
 * @param {string[]|Set<string>} selectedIds
 * @param {boolean} dryRun
 * @param {(done:number,total:number,currentFileName:string)=>void} onProgress
 * @returns {{results:Array, stats:{success,failed,skipped}}}
 */
async function executeRenameAll(tracks, selectedIds, dryRun = false, onProgress) {
  const selected = new Set(selectedIds instanceof Set ? selectedIds : (selectedIds || []));
  const list = tracks || [];
  const toProcess = list.filter(t => t && t.id && selected.has(t.id));
  const total = toProcess.length;

  const results = [];
  const stats = { success: 0, failed: 0, skipped: 0 };

  let done = 0;
  for (const t of toProcess) {
    let res;
    try {
      res = await executeRename(t, dryRun);
    } catch (err) {
      res = { success: false, oldPath: t.filePath, newPath: '', error: err.message };
    }
    if (res.success) {
      if (res.warning === 'name invariato') stats.skipped++;
      else stats.success++;
    } else {
      stats.failed++;
    }
    results.push({ trackId: t.id, ...res });
    done++;
    if (typeof onProgress === 'function') {
      try {
        onProgress(done, total, res.newPath ? path.basename(res.newPath) : t.fileName || '');
      } catch { /* noop */ }
    }
  }

  return { results, stats };
}

// ---------------------------------------------------------------------------
// Retro-compat
// ---------------------------------------------------------------------------

function buildNewPath(oldPath, newBaseName) {
  const dir = path.dirname(oldPath);
  const safe = sanitizeFileName(newBaseName);
  return path.join(dir, `${safe}${extOf(oldPath)}`);
}

function _legacyResult(track) {
  const r = generateNewFileName(track);
  const dir = path.dirname(track.filePath || '');
  return {
    oldPath: track.filePath,
    newPath: path.join(dir, r.newFileName),
    newName: r.newFileName,
    strategy: r.strategy,
    canRename: r.canRename,
    reason: r.reason,
    hasBpm: r.hasBpm,
  };
}

const renameSingle = (track) => _legacyResult(track);
const renameMashup = (track) => _legacyResult(track);
const renameMix = (track) => _legacyResult(track);

module.exports = {
  // spec
  formatBpm,
  generateNewFileName,
  previewRenames,
  executeRename,
  executeRenameAll,
  // retro-compat
  renameSingle,
  renameMashup,
  renameMix,
  buildNewPath,
  _internals: {
    extractEditType,
    stripEditAnnotations,
    splitArtistsForMashup,
    buildMixCore,
    mixAverageBpm,
    hasUsableLocalTags,
    capCore,
  },
};
