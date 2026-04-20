/**
 * src/main/handlers/settings.js
 *
 * Handler: settings:get/set, config:get/set, config:test-api, config:testApi,
 * shazam:test, replicate:test, acoustid:test.
 *
 * Boot-time: propaga credenziali salvate ai servizi interessati.
 */

'use strict';

const acrcloudService = require('../../services/acrcloudService');
const shazamService = require('../../services/shazamService');
const aiGenreService = require('../../services/aiGenreService');
const analysisQueue = require('../../services/analysisQueue');
const {
  pickAcrCredentials, pickAcoustidKey, pickReplicateToken,
  getEmbeddedKeyFlags,
} = require('../../constants/embeddedKeysLoader');

function register(ctx) {
  const { ipcMain, store, app, ok, fail } = ctx;

  ipcMain.handle('settings:get', async () => {
    try {
      const full = { ...store.store };
      try {
        if (process.platform === 'win32') {
          full.startWithWindows = !!app.getLoginItemSettings().openAtLogin;
        } else {
          full.startWithWindows = false;
        }
      } catch { full.startWithWindows = false; }
      if (full.notificationsEnabled === undefined) full.notificationsEnabled = true;
      // Flag "chiavi precompilate" — l'UI le mostra come read-only / già attive
      // così l'utente finale non deve inserire nulla.
      full._embeddedKeys = getEmbeddedKeyFlags();
      return ok(full);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('settings:set', async (_e, partial) => {
    try {
      const p = partial || {};
      for (const [k, v] of Object.entries(p)) {
        if (k === 'startWithWindows') continue;
        store.set(k, v);
      }
      if ('startWithWindows' in p && process.platform === 'win32') {
        app.setLoginItemSettings({
          openAtLogin: !!p.startWithWindows,
          openAsHidden: true,
        });
      }
      // Cascata user → env → embedded anche per le set al runtime
      if ('replicateToken' in p) {
        try { aiGenreService.setReplicateToken(pickReplicateToken(p.replicateToken)); } catch { /* noop */ }
      }
      if ('analysisConcurrency' in p) {
        try { analysisQueue.setConcurrency(p.analysisConcurrency); } catch { /* noop */ }
      }
      if ('acoustidKey' in p) {
        try {
          const mbService = require('../../services/musicbrainzService');
          if (mbService.setAcoustidKey) mbService.setAcoustidKey(pickAcoustidKey(p.acoustidKey));
        } catch { /* noop */ }
      }
      const acr = store.get('acrcloud') || {};
      acrcloudService.setCredentials(pickAcrCredentials(acr));
      return ok(store.store);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('config:get', async (_e, key) => {
    try { return ok(key ? store.get(key) : store.store); } catch (e) { return fail(e); }
  });

  ipcMain.handle('config:set', async (_e, key, value) => {
    try {
      store.set(key, value);
      if (typeof key === 'string' && (key.startsWith('acr') || key === 'acrcloud')) {
        const acr = store.get('acrcloud') || {};
        acrcloudService.setCredentials(acr);
      }
      return ok(true);
    } catch (e) { return fail(e); }
  });

  // Test API endpoints
  ipcMain.handle('config:test-api', async () => {
    try { return ok(await acrcloudService.testConnection({ seconds: 5 })); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('config:testApi', async () => {
    try {
      const r = await acrcloudService.testConnection({ seconds: 5 });
      return ok({ online: r.success, reason: r.error || null, responseTime: r.responseTime });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('shazam:test', async () => {
    try { return ok(await shazamService.testConnection()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('replicate:test', async (_e, maybeToken) => {
    try {
      const axios = require('axios');
      const token = String(
        maybeToken || process.env.REPLICATE_TOKEN || store.get('replicateToken') || ''
      ).trim();
      if (!token) return ok({ ok: false, message: 'Token non configurato' });
      const r = await axios.get('https://api.replicate.com/v1/account', {
        headers: { 'Authorization': `Token ${token}` },
        timeout: 10_000,
        validateStatus: s => s < 500,
      });
      if (r.status === 200) {
        return ok({ ok: true, message: `Account: ${r.data?.username || 'valido'}` });
      }
      return ok({ ok: false, message: `Token non valido (${r.status})` });
    } catch (e) {
      return ok({ ok: false, message: `Errore: ${e.message}` });
    }
  });

  // AcoustID: test validità chiave via /v2/lookup con fingerprint dummy.
  //
  // Codici di risposta AcoustID (https://acoustid.org/webservice):
  //   code 3 → "invalid fingerprint" → la chiave è OK, il fingerprint no (atteso)
  //   code 6 → alias antichi di code 3 in alcune versioni → chiave OK
  //   code 4 → "invalid API key" → la chiave NON è valida su questo endpoint
  //
  // IMPORTANTE — AcoustID distingue due tipi di chiavi:
  //   • User API Key       (~10 char, visibile in /account) → solo per SUBMIT
  //   • Application API Key (~8 char, da /new-application)  → per LOOKUP
  // L'endpoint /v2/lookup richiede la Application Key. Se l'utente incolla
  // la User Key, il server risponde code 4: dobbiamo segnalare questo caso.
  ipcMain.handle('acoustid:test', async (_e, key) => {
    const k = String(key || '').trim();
    if (!k || k.length < 5) {
      return { ok: false, message: '⚠️ Chiave troppo corta — incolla tutta la chiave da acoustid.org' };
    }
    try {
      const axios = require('axios');
      const resp = await axios.get('https://api.acoustid.org/v2/lookup', {
        params: { client: k, duration: 30, fingerprint: 'AAAA', format: 'json' },
        timeout: 8000,
        validateStatus: () => true,
      });
      const data = resp.data || {};
      const errCode = data.status === 'error' ? Number(data.error?.code) : 0;

      // Valida: code 3 o 6 = fingerprint invalido → chiave ACCETTATA dal server
      if (errCode === 3 || errCode === 6) {
        return { ok: true, message: '🟢 Chiave valida — AcoustID pronto per il riconoscimento' };
      }

      // status "ok" (nessun errore) = chiave valida (caso teorico, raro con FP=AAAA)
      if (data.status === 'ok') {
        return { ok: true, message: '🟢 Chiave valida — AcoustID attivo' };
      }

      // code 4 = invalid API key — quasi sempre User Key incollata al posto di App Key
      if (errCode === 4) {
        const looksLikeUserKey = k.length >= 10; // User keys tipicamente 10+ char
        const tip = looksLikeUserKey
          ? '\n\nSembra che tu abbia incollato la USER API Key (profilo acoustid.org).\n' +
            'Per il riconoscimento serve una APPLICATION API Key:\n' +
            '→ registra un\'app su https://acoustid.org/new-application\n' +
            '→ la chiave generata lì va inserita qui (tipicamente 8 caratteri)'
          : '\n\nControlla di aver incollato la chiave giusta (Application API Key).';
        return {
          ok: false,
          message: '🔴 Chiave rifiutata dal server AcoustID (code 4)' + tip,
          errorCode: 4,
          userKeyDetected: looksLikeUserKey,
        };
      }

      if (resp.status === 401 || resp.status === 403) {
        return { ok: false, message: '🔴 Chiave non autorizzata (HTTP ' + resp.status + ')' };
      }

      // Qualsiasi altro codice AcoustID: riporta messaggio del server
      if (data.status === 'error' && data.error?.message) {
        return {
          ok: false,
          message: `🔴 Server AcoustID: ${data.error.message} (code ${errCode})`,
          errorCode: errCode,
        };
      }

      // Fallback conservativo: se il server risponde qualcosa che NON è code 4
      // e NON è un errore riconoscibile, accettiamo come valida.
      return { ok: true, message: '🟢 Chiave accettata dal server AcoustID' };
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        return { ok: false, message: '🔴 Chiave non autorizzata' };
      }
      return { ok: false, message: `🔴 Errore connessione AcoustID: ${err.message}` };
    }
  });
}

/**
 * Boot: cascata di sorgenti per le chiavi API.
 * Priorità decrescente: impostazioni utente (electron-store) → .env →
 * embedded-keys.local.js (bundled nel build) → embedded-keys.js (template).
 *
 * L'utente finale NON deve inserire nulla se le chiavi sono bundled:
 * l'unico input richiesto è la cartella di destinazione.
 */
function boot({ store }) {
  try {
    const acr = pickAcrCredentials(store.get('acrcloud') || {});
    acrcloudService.setCredentials(acr);
    if (acr.key && acr.secret) {
      console.log('[boot] ACRCloud: credentials OK (host=' + (acr.host || 'default') + ')');
    }
  } catch (err) { console.warn('[boot] acrcloud:', err.message); }

  try {
    const rt = pickReplicateToken(store.get('replicateToken', ''));
    if (rt) {
      aiGenreService.setReplicateToken(rt);
      console.log('[boot] Replicate: token OK');
    }
  } catch (err) { console.warn('[boot] replicateToken:', err.message); }

  try {
    const c = store.get('analysisConcurrency', 3);
    analysisQueue.setConcurrency(c);
  } catch (err) { console.warn('[boot] analysisConcurrency:', err.message); }

  try {
    const mbService = require('../../services/musicbrainzService');
    const acoustid = pickAcoustidKey(store.get('acoustidKey', ''));
    if (acoustid && mbService.setAcoustidKey) {
      mbService.setAcoustidKey(acoustid);
      console.log('[boot] AcoustID: key OK');
    } else if (mbService.initFromStore) {
      mbService.initFromStore(store);
    }
  } catch (err) { console.warn('[boot] musicbrainz init:', err.message); }
}

module.exports = { register, boot };
