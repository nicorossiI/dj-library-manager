/**
 * src/utils/errorMessages.js
 *
 * Messaggi di errore user-facing in italiano semplice.
 * Zero gergo tecnico. Stack trace e codici restano solo nel log.
 *
 * Uso: `const { getErrorMessage, classifyError } = require('.../errorMessages');`
 *       `pushLog({ message: getErrorMessage('ACR_NO_KEY') })`
 *       `const code = classifyError(err); pushLog({ message: getErrorMessage(code, err) })`
 */

'use strict';

const ERROR_MESSAGES = Object.freeze({
  // ACRCloud
  ACR_NO_KEY:
    '🔑 Chiave API non inserita. Vai in Impostazioni (⚙️) ' +
    'per inserire le credenziali ACRCloud gratuite.',
  ACR_RATE_LIMIT:
    '⏳ Hai raggiunto il limite giornaliero di riconoscimenti. ' +
    'Riprova domani o vai su acrcloud.com per aumentare il limite.',
  ACR_NETWORK:
    '📶 Nessuna connessione internet. L\'app continua a funzionare ' +
    'ma non può riconoscere i nomi delle canzoni automaticamente.',
  ACR_AUTH:
    '🔑 Credenziali ACRCloud non valide. Controlla Host, Key e Secret ' +
    'nelle Impostazioni.',

  // AcoustID / MusicBrainz
  ACOUSTID_RATE_LIMIT:
    '⏳ Troppe richieste ad AcoustID. Attendi qualche minuto ' +
    'o registra una chiave personale su acoustid.org.',

  // Shazam
  SHAZAM_UNAVAILABLE:
    '🎵 Shazam non raggiungibile. Controlla la connessione internet. ' +
    'L\'app continua con gli altri metodi di riconoscimento.',

  // Discogs / Last.fm
  DISCOGS_NO_TOKEN:
    '🔑 Token Discogs non inserito. È opzionale — serve solo per ' +
    'migliorare il riconoscimento del genere musicale.',
  LASTFM_NO_KEY:
    '🔑 Chiave Last.fm non inserita. È opzionale — serve solo per ' +
    'rilevare i generi di artisti non coperti da Discogs.',

  // File system
  FILE_LOCKED:
    '🔒 Il file è in uso da un altro programma. ' +
    'Chiudi qualsiasi player musicale e riprova.',
  NO_PERMISSION:
    '🚫 Non ho il permesso di modificare questo file. ' +
    'Prova a spostarlo in una cartella diversa, ' +
    'come il Desktop o Documenti.',
  DISK_FULL:
    '💾 Disco pieno. Libera dello spazio e riprova.',
  PATH_TOO_LONG:
    '📁 Il percorso della cartella è troppo lungo. ' +
    'Sposta i file in una cartella più vicina alla radice, ' +
    'come C:\\Musica DJ\\',
  FILE_NOT_FOUND:
    '❓ File non trovato. Potrebbe essere stato spostato o eliminato.',

  // Binari esterni
  FPCALC_MISSING:
    '🔧 File mancante: fpcalc.exe. ' +
    'Chiudi l\'app, apri la cartella dell\'applicazione ' +
    'e lancia setup.js oppure scarica fpcalc.exe ' +
    'da acoustid.org e mettilo nella cartella assets/bin/',
  KEYFINDER_MISSING:
    '🔧 keyfinder-cli.exe non trovato. ' +
    'L\'app continuerà con il rilevamento chiave alternativo (essentia.js). ' +
    'Per usare keyfinder-cli, lancia setup.js.',
  FFMPEG_MISSING:
    '🔧 ffmpeg non disponibile. Reinstalla l\'app o lancia setup.js.',

  // Rekordbox
  XML_WRITE_ERROR:
    '⚠️ Non riesco ad aggiornare il file Rekordbox. ' +
    'Assicurati che Rekordbox non sia aperto. ' +
    'Chiudi Rekordbox e riprova.',
  XML_INVALID:
    '⚠️ Il file rekordbox.xml è danneggiato. ' +
    'Rigeneralo dal tab Rekordbox per ripararlo.',

  // Generico
  NETWORK:
    '📶 Nessuna connessione internet. Ripoverò quando sarai online.',
  UNKNOWN:
    '❌ Qualcosa è andato storto con questo file. ' +
    'L\'app continua con gli altri file. ' +
    'Puoi riprovare trascinando il file nell\'app.',
});

/**
 * Euristica per riconoscere un errore Node/Electron e mappare a un codice
 * user-friendly. Se nessun pattern matcha → 'UNKNOWN'.
 */
function classifyError(err) {
  if (!err) return 'UNKNOWN';
  const code = String(err.code || '').toUpperCase();
  const msg = String(err.message || err || '').toLowerCase();

  if (code === 'EACCES' || /permission denied|access is denied/.test(msg)) return 'NO_PERMISSION';
  if (code === 'EBUSY' || code === 'EPERM' || /is being used|locked/.test(msg)) return 'FILE_LOCKED';
  if (code === 'ENOSPC' || /no space left/.test(msg)) return 'DISK_FULL';
  if (code === 'ENAMETOOLONG' || /path too long/.test(msg)) return 'PATH_TOO_LONG';
  if (code === 'ENOENT' || /no such file/.test(msg)) {
    if (/fpcalc/.test(msg)) return 'FPCALC_MISSING';
    if (/keyfinder/.test(msg)) return 'KEYFINDER_MISSING';
    if (/ffmpeg/.test(msg)) return 'FFMPEG_MISSING';
    return 'FILE_NOT_FOUND';
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || /network|offline/.test(msg)) return 'NETWORK';
  if (/401|unauthorized|invalid.*(key|token|access|signature)/.test(msg)) return 'ACR_AUTH';
  if (/429|rate.?limit|too many requests/.test(msg)) return 'ACR_RATE_LIMIT';
  if (/rekordbox\.xml|xml.*write/.test(msg)) return 'XML_WRITE_ERROR';
  return 'UNKNOWN';
}

/**
 * @param {string} code     — chiave di ERROR_MESSAGES o 'UNKNOWN'
 * @param {any}    [techErr] — errore originale, loggato per debug
 */
function getErrorMessage(code, techErr) {
  const key = (code && ERROR_MESSAGES[code]) ? code : 'UNKNOWN';
  if (techErr) {
    try {
      console.error('[TECNICO]', code, techErr?.stack || techErr?.message || techErr);
    } catch { /* noop */ }
  }
  return ERROR_MESSAGES[key];
}

/**
 * Shortcut: traduce direttamente un Error in messaggio user-friendly.
 */
function humanize(err) {
  return getErrorMessage(classifyError(err), err);
}

module.exports = {
  ERROR_MESSAGES,
  classifyError,
  getErrorMessage,
  humanize,
};
