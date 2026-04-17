/**
 * src/services/vocalLanguageService.js
 *
 * Rilevamento lingua VOCALS a cascata:
 *   1. Match artisti noti (ARTISTS_ES / ARTISTS_IT / ARTISTS_EN)
 *      — con word-boundary regex (no substring match naïve)
 *   2. franc-min su testo riconosciuto (artista + titolo ACR/Shazam)
 *   3. franc-min sul nome file pulito
 *   4. Default 'mixed'
 *
 * Output: 'es' | 'it' | 'it_es' | 'en' | 'mixed'
 *
 * WORD-BOUNDARY: il match accetta separatori DJ-typical (spazio, trattino,
 * underscore, punto, virgola, x/×/&/+//) prima e dopo l'artista. Così
 * "bad bunny" matcha "bad_bunny_spotdown" e "j balvin x bad bunny" ma NON
 * matcha "badger bunny" o "embed bunny".
 *
 * DIACRITICS: testo e artisti sono normalizzati rimuovendo accenti per
 * evitare miss con "Sebastián" vs "sebastian".
 */

'use strict';

// ---------------------------------------------------------------------------
// Normalizzazione
// ---------------------------------------------------------------------------

function stripDiacritics(s = '') {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalize(s = '') {
  return stripDiacritics(String(s)).toLowerCase();
}

// ── ARTISTI SPAGNOLI / LATINI ────────────────────────────────────
// Tutti già lowercased e senza diacritici (normalizzati al match).
const ARTISTS_ES = new Set([
  // Reggaeton / Latin Urban classico
  'bad bunny', 'j balvin', 'rauw alejandro', 'daddy yankee',
  'nicky jam', 'ozuna', 'maluma', 'karol g', 'feid', 'jhay cortez',
  'myke towers', 'anuel aa', 'farruko', 'sech', 'justin quiles',
  'j quiles', 'lerica', 'becky g', 'chencho corleone',
  // Dembow dominicano
  'el alfa', 'rochy rd', 'bulin 47', 'chimbala', 'mozart la para',
  'secreto', 'secreto el famoso biberon', 'dj yakarta', 'dj scuff',
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

  // ── Nuova scena urbana latina 2023-2025 (corridos tumbados, regional mex)
  'peso pluma', 'eslabon armado', 'natanael cano',
  'junior h', 'gabito ballesteros', 'yahritza',
  'marca mp', 'xavi', 'ivan cornejo',
  // Urban PR/Colombia nuova ondata
  'young miko', 'jhyve', 'blessd', 'ryan castro',
  'dalex', 'amenazzy',
  // Dembow/Urbano classico extra
  'wisin', 'yandel', 'plan b',
  // DR drill/dembow
  'luar la l',
  // Afrobeats/funk brasiliano latino (vocals ES/PT)
  'anitta', 'dennis dj', 'bonde r300',
  // Colombiani/ecuadoriani pop
  'mario bautista',
]);

// ── ARTISTI ITALIANI ─────────────────────────────────────────────
const ARTISTS_IT = new Set([
  // Trap / hip hop italiano (classici)
  'sfera ebbasta', 'tony effe', 'fedez', 'marracash', 'salmo',
  'capo plaza', 'rkomi', 'mahmood', 'blanco', 'irama',
  'lazza', 'luche', 'geolier', 'liberato', 'nino brown',
  'shiva', 'anna', 'villabanks', 'ernia', 'gue pequeno', 'gue',
  'jake la furia', 'dark polo gang', 'pyrex',
  'neo solaris', 'uwaie', 'guido dj', 'chimu dj',
  'samuele brignoccolo', 'ossessione', 'federico bolletta',
  'mattia olivi', 'random', 'drillionaire', 'sacky',
  'nardi', 'vale pain', 'artie 5ive', 'ackeejuice rockers',
  // Pop italiano
  'elettra lamborghini', 'boomdabash', 'rocco hunt',
  'baby k', 'elodie', 'giorgia', 'levante',
  // Afrohouse/electronic italiano
  'ghali', 'frah quintale', 'mace', 'tha supreme',

  // ── Nuova scena italiana 2023-2025
  'rondodasosa', 'simba la rue', 'baby gang', 'neima ezza',
  'young signorino', 'tedua', 'izi',
  'gazzelle', 'calcutta', 'coez',
  'el nino', 'neffa', 'ensi',
  'murubutu', 'claver gold',
  'me contro te',
  'massimo pericolo', 'mostro',
  'kento', 'nto',
]);

// ── ARTISTI INGLESI / INTERNAZIONALI ─────────────────────────────
const ARTISTS_EN = new Set([
  // Hip Hop / Trap US
  'drake', 'the weeknd', 'post malone', 'travis scott',
  'kendrick lamar', 'j cole', '21 savage', 'lil baby',
  'gunna', 'polo g', 'roddy ricch', 'pop smoke',
  'dababy', 'lil uzi vert', 'young thug',
  'nba youngboy', 'juice wrld', 'xxxtentacion',
  'cardi b', 'nicki minaj', 'megan thee stallion',
  'doja cat', 'lizzo', 'sza', 'dua lipa',
  // R&B / Soul
  'beyonce', 'rihanna', 'frank ocean',
  'h.e.r.', 'khalid', 'summer walker', 'bryson tiller',
  // Pop internazionale
  'ed sheeran', 'charlie puth', 'sam smith', 'adele',
  'billie eilish', 'ariana grande', 'taylor swift',
  'justin bieber', 'harry styles', 'olivia rodrigo',
  // Afrobeats (EN / internazionale)
  'burna boy', 'wizkid', 'davido',
  'ckay', 'fireboy dml', 'rema', 'tems', 'ayra starr',
  'kizz daniel', 'omah lay', 'victony', 'joeboy',
  // UK rap/drill
  'stormzy', 'dave', 'skepta', 'aitch', 'central cee',
  'little simz', 'slowthai', 'digga d', 'headie one',
  // Dance/Electronic internazionale
  'david guetta', 'calvin harris', 'tiesto', 'martin garrix',
  'marshmello', 'the chainsmokers', 'diplo', 'major lazer',
  // Legacy
  'missy elliott',
]);

// ---------------------------------------------------------------------------
// Word-boundary match
// ---------------------------------------------------------------------------

// Separatori validi DJ/filename: inizio/fine stringa, whitespace, - _ . , / +
// e × x & (collaborazioni). Tutto il resto → nessun match (evita
// "bad bunny" ⊂ "badger bunny" e "embed bunny").
const BOUNDARY = '(?:^|[\\s\\-_.,/+&×x])';
const BOUNDARY_END = '(?:$|[\\s\\-_.,/+&×x])';
// Gli spazi INTERNI all'artista ("bad bunny") vanno trattati in modo permissivo
// perché nei filename DJ si trovano anche come _, -, . (es. "bad_bunny_spotdown",
// "j.cole", "feid.dj.scuff"). Almeno 1 separatore obbligatorio.
const INTERNAL_SEP = '[\\s\\-_./+&]+';

function artistMatchesText(artist, text) {
  if (!artist || !text) return false;
  const parts = String(artist)
    .trim()
    .split(/\s+/)
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const core = parts.join(INTERNAL_SEP);
  const pattern = new RegExp(BOUNDARY + core + BOUNDARY_END, 'i');
  return pattern.test(text);
}

// ---------------------------------------------------------------------------
// Estrazione testo dal track
// ---------------------------------------------------------------------------

function extractArtistsFromTrack(track = {}) {
  const sources = [];

  if (track.fileName) {
    const clean = String(track.fileName)
      .replace(/\.(mp3|wav|flac|aac|m4a|aiff?|ogg)$/i, '')
      .replace(/_/g, ' ')
      .replace(/\b(KLICKAUD|SPOTDOWN|SOUNDCLOUD|FREE.?DL|PITCHED|COPYRIGHT|DOWNLOAD|MEDAL|HQ|spotdown\.org|128K|320K)\b/gi, '')
      .replace(/\s+/g, ' ');
    sources.push(clean);
  }
  if (track.recognizedArtist) sources.push(String(track.recognizedArtist));
  if (track.recognizedTitle)  sources.push(String(track.recognizedTitle));
  if (track.bestArtist)       sources.push(String(track.bestArtist));
  if (track.localArtist)      sources.push(String(track.localArtist));

  return normalize(sources.join(' '));
}

// ---------------------------------------------------------------------------
// Step 1 — match artisti noti (con word boundary)
// ---------------------------------------------------------------------------

function detectLanguageFromArtists(text = '') {
  const t = normalize(text);
  if (!t) return null;

  const foundES = [];
  const foundIT = [];
  const foundEN = [];

  for (const artist of ARTISTS_ES) if (artistMatchesText(artist, t)) foundES.push(artist);
  for (const artist of ARTISTS_IT) if (artistMatchesText(artist, t)) foundIT.push(artist);
  for (const artist of ARTISTS_EN) if (artistMatchesText(artist, t)) foundEN.push(artist);

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

  // STEP 3 — franc sul nome file pulito
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
  artistMatchesText,
  ARTISTS_ES,
  ARTISTS_IT,
  ARTISTS_EN,
};
