/**
 * src/services/vocalLanguageService.js
 *
 * Rilevamento lingua VOCALS a cascata:
 *   1. Match artisti noti (ARTISTS_ES / ARTISTS_IT / ARTISTS_EN)
 *   2. franc-min su testo riconosciuto (artista + titolo ACR/Shazam)
 *   3. franc-min sul nome file pulito (dopo strip scraper suffix)
 *   4. Default 'mixed'
 *
 * Output: 'es' | 'it' | 'it_es' | 'en' | 'mixed'
 *
 * Il match artisti è più affidabile di franc (che su stringhe corte
 * di 2-3 parole spesso sbaglia). franc resta fallback utile per tracce
 * senza artista noto.
 */

'use strict';

// ── ARTISTI SPAGNOLI / LATINI ────────────────────────────────────
const ARTISTS_ES = new Set([
  // Reggaeton / Latin Urban classico
  'bad bunny', 'j balvin', 'rauw alejandro', 'daddy yankee',
  'nicky jam', 'ozuna', 'maluma', 'karol g', 'feid', 'jhay cortez',
  'myke towers', 'anuel aa', 'farruko', 'sech', 'justin quiles',
  'j quiles', 'lerica', 'becky g', 'chencho corleone',
  // Dembow dominicano
  'el alfa', 'rochy rd', 'bulin 47', 'chimbala', 'mozart la para',
  'secreto el famoso biberon', 'dj yakarta', 'dj scuff',
  'el mayor clasico', 'shelow shaq', 'quimico ultra mega',
  // Trap / drill latino
  'trueno', 'duki', 'bizarrap', 'paulo londra', 'khea', 'lit killah',
  'tiago pzk', 'neo pistea', 'standly', 'rusherking', 'rei',
  'la joaqui', 'villano antillano', 'dei v', 'quevedo', 'rels b',
  'morad', 'eladio carrion', 'arcangel', 'de la ghetto',
  // Afrobeats latini / pop
  'paloma mami', 'mc kevinho', 'mc livinho', 'bad gyal', 'omar courtz',
  // Salsa / bachata
  'romeo santos', 'prince royce', 'aventura', 'marc anthony',
  'cali y el dandee',
  // Generali ispanofoni
  'sebastian yatra', 'camilo', 'shakira', 'enrique iglesias',
  'pitbull', 'pam', 'santa rm', 'lenny tavarez', 'mora',
  'jhoni el que sabe', 'lunay', 'brray', 'noriel',
  // Rvssian (produttore jamaicano con roster ES)
  'rvssian', 'notch', 'tanto metro',
]);

// ── ARTISTI ITALIANI ─────────────────────────────────────────────
const ARTISTS_IT = new Set([
  // Trap / hip hop italiano
  'sfera ebbasta', 'tony effe', 'fedez', 'marracash', 'salmo',
  'capo plaza', 'rkomi', 'mahmood', 'blanco', 'irama',
  'lazza', 'luche', 'lucè', 'luchè', 'geolier', 'liberato', 'nino brown',
  'shiva', 'anna', 'villabanks', 'ernia', 'gue pequeno', 'gué',
  'jake la furia', 'dark polo gang', 'pyrex',
  'neo solaris', 'uwaie', 'guido dj', 'chimu dj',
  // Nuova scena
  'samuele brignoccolo', 'ossessione', 'federico bolletta',
  'mattia olivi', 'random', 'drillionaire', 'sacky',
  'nardi', 'vale pain', 'artie 5ive', 'ackeejuice rockers',
  // Pop italiano
  'elettra lamborghini', 'boomdabash', 'rocco hunt',
  'baby k', 'elodie', 'giorgia', 'levante',
  // Afrohouse/electronic italiano
  'ghali', 'frah quintale', 'mace', 'tha supreme',
]);

// ── ARTISTI INGLESI / INTERNAZIONALI ─────────────────────────────
const ARTISTS_EN = new Set([
  'beyonce', 'rihanna', 'drake', 'the weeknd', 'doja cat',
  'cardi b', 'nicki minaj', 'missy elliott', '21 savage',
  'lil baby', 'gunna', 'polo g', 'roddy ricch', 'pop smoke',
  'burna boy', 'wizkid', 'davido',
]);

// ---------------------------------------------------------------------------
// Text normalization helpers
// ---------------------------------------------------------------------------

function extractArtistsFromTrack(track = {}) {
  const sources = [];

  if (track.fileName) {
    const clean = String(track.fileName)
      .replace(/\.(mp3|wav|flac|aac|m4a|aiff?|ogg)$/i, '')
      .replace(/_/g, ' ')
      .replace(/\b(KLICKAUD|SPOTDOWN|SOUNDCLOUD|FREE.?DL|PITCHED|COPYRIGHT|DOWNLOAD|MEDAL|HQ|spotdown\.org|128K|320K)\b/gi, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    sources.push(clean);
  }

  if (track.recognizedArtist) sources.push(String(track.recognizedArtist).toLowerCase());
  if (track.recognizedTitle)  sources.push(String(track.recognizedTitle).toLowerCase());
  if (track.bestArtist)       sources.push(String(track.bestArtist).toLowerCase());
  if (track.localArtist)      sources.push(String(track.localArtist).toLowerCase());

  return sources.join(' ');
}

// ---------------------------------------------------------------------------
// Step 1 — match artisti noti
// ---------------------------------------------------------------------------

function detectLanguageFromArtists(text = '') {
  const t = String(text).toLowerCase();
  if (!t) return null;

  const foundES = [];
  const foundIT = [];
  const foundEN = [];

  // substring match case-insensitive con word-boundary approssimata
  for (const a of ARTISTS_ES) if (t.includes(a)) foundES.push(a);
  for (const a of ARTISTS_IT) if (t.includes(a)) foundIT.push(a);
  for (const a of ARTISTS_EN) if (t.includes(a)) foundEN.push(a);

  if (foundIT.length && foundES.length) return 'it_es';
  if (foundIT.length && !foundEN.length) return 'it';
  if (foundES.length && !foundEN.length) return 'es';
  if (foundEN.length && !foundIT.length && !foundES.length) return 'en';
  // Tie-breakers: priorità IT/ES su EN quando c'è sovrapposizione
  if (foundIT.length && foundEN.length) return 'it';
  if (foundES.length && foundEN.length) return 'es';

  return null;
}

// ---------------------------------------------------------------------------
// Step 2/3 — franc-min (ESM) come fallback su testo
// ---------------------------------------------------------------------------

let _franc = null;
async function getFranc() {
  if (_franc) return _franc;
  try {
    const mod = await import('franc-min');
    _franc = mod.franc || mod.default?.franc || mod.default;
  } catch {
    _franc = null;
  }
  return _franc;
}

async function detectLanguageFromText(text = '') {
  const t = String(text || '').trim();
  if (t.length < 4) return null;
  try {
    const franc = await getFranc();
    if (!franc) return null;
    // franc accetta { only: [...] } per restringere le ipotesi
    const code = franc(t, { only: ['spa', 'ita', 'eng'] });
    const MAP = { spa: 'es', ita: 'it', eng: 'en', und: null };
    return MAP[code] || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main: detectVocalLanguage(track) — cascata a 4 step
// ---------------------------------------------------------------------------

/**
 * @param {object} track
 * @returns {Promise<'es'|'it'|'it_es'|'en'|'mixed'>}
 * Side-effect: imposta track.languageSource con lo step che ha vinto.
 */
async function detectVocalLanguage(track = {}) {
  // STEP 1 — artisti noti (il più affidabile)
  const fullText = extractArtistsFromTrack(track);
  const artistLang = detectLanguageFromArtists(fullText);
  if (artistLang) {
    track.languageSource = 'artist_match';
    return artistLang;
  }

  // STEP 2 — franc su testo riconosciuto
  const recognitionText = [
    track.recognizedArtist, track.recognizedTitle,
    track.bestArtist, track.bestTitle,
  ].filter(Boolean).join(' ');
  if (recognitionText.length > 3) {
    const francLang = await detectLanguageFromText(recognitionText);
    if (francLang && francLang !== 'en') {
      track.languageSource = 'franc_recognition';
      return francLang;
    }
  }

  // STEP 3 — franc sul nome file pulito (senza keyword genere/edit)
  const cleanName = String(track.fileName || '')
    .replace(/\.(mp3|wav|flac|aac|m4a|aiff?|ogg)$/i, '')
    .replace(/[_\-\.]/g, ' ')
    .replace(/\b(KLICKAUD|SPOTDOWN|SOUNDCLOUD|FREE.?DL|PITCHED|COPYRIGHT|DOWNLOAD|MEDAL|HQ|spotdown\.org|128K|320K|edit|mashup|afrohouse|techhouse|deephouse|remix|bootleg|blend|extended|version|transition)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleanName.length > 5) {
    const francFileLang = await detectLanguageFromText(cleanName);
    if (francFileLang) {
      track.languageSource = 'franc_filename';
      return francFileLang;
    }
  }

  track.languageSource = 'default';
  return 'mixed';
}

module.exports = {
  detectVocalLanguage,
  detectLanguageFromArtists,
  detectLanguageFromText,
  extractArtistsFromTrack,
  ARTISTS_ES,
  ARTISTS_IT,
  ARTISTS_EN,
};
