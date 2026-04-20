/**
 * src/constants/embedded-keys.js
 *
 * Chiavi API bundled nel build — l'utente finale NON deve inserirle.
 * Questo file è IL TEMPLATE committato con chiavi vuote.
 *
 * ── Come popolarle per il TUO build ────────────────────────────────
 * 1. Copia questo file in `src/constants/embedded-keys.local.js`
 * 2. Incolla lì le tue chiavi (reali)
 * 3. Il loader carica PRIMA `.local.js` se esiste, poi fa fallback qui
 * 4. Il file `.local.js` è gitignorato, non finisce mai su GitHub
 * 5. Quando fai `npm run publish`, le chiavi da `.local.js` vengono
 *    incluse nel `.exe` (electron-builder bundla tutti i file src)
 *
 * ── Priorità runtime (decrescente) ─────────────────────────────────
 *   1. Settings utente salvate (electron-store) — override esplicito
 *   2. Variabili d'ambiente (.env, solo in sviluppo)
 *   3. embedded-keys.local.js (se presente — chiavi amministratore)
 *   4. embedded-keys.js (questo file, vuoto)
 *
 * ⚠️  SICUREZZA: chiunque apra il .exe può estrarre le chiavi. Per uso
 *    DJ privato è accettabile. Per distribuzione pubblica valuta quote
 *    e rate-limit dei provider (ACRCloud, Replicate).
 */

'use strict';

/** @type {import('./embedded-keys.types').EmbeddedKeys} */
const EMPTY_EMBEDDED_KEYS = Object.freeze({
  acrcloud: Object.freeze({
    host:   '',
    key:    '',
    secret: '',
  }),
  acoustid: '',
  replicate: '',
  discogs:  '',
  lastfm:   '',
});

module.exports = EMPTY_EMBEDDED_KEYS;
