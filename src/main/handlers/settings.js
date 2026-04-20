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
      if ('replicateToken' in p) {
        try { aiGenreService.setReplicateToken(p.replicateToken || ''); } catch { /* noop */ }
      }
      if ('analysisConcurrency' in p) {
        try { analysisQueue.setConcurrency(p.analysisConcurrency); } catch { /* noop */ }
      }
      if ('acoustidKey' in p) {
        try {
          const mbService = require('../../services/musicbrainzService');
          if (mbService.setAcoustidKey) mbService.setAcoustidKey(p.acoustidKey || '');
        } catch { /* noop */ }
      }
      const acr = store.get('acrcloud') || {};
      acrcloudService.setCredentials(acr);
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

  ipcMain.handle('acoustid:test', async (_e, key) => {
    const k = String(key || '').trim();
    if (!k || k.length < 5) {
      return { ok: false, message: 'Chiave troppo corta' };
    }
    try {
      const axios = require('axios');
      const resp = await axios.get('https://api.acoustid.org/v2/lookup', {
        params: { client: k, duration: 30, fingerprint: 'AAAA', format: 'json' },
        timeout: 8000,
        validateStatus: () => true,
      });
      const data = resp.data || {};
      const errCode = data.status === 'error' ? data.error?.code : 0;
      if (errCode === 4) {
        return { ok: false, message: '🔴 Chiave non valida (client key rifiutata)' };
      }
      if (resp.status === 401 || resp.status === 403) {
        return { ok: false, message: '🔴 Chiave non valida' };
      }
      return { ok: true, message: '🟢 Chiave valida — AcoustID attivo' };
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        return { ok: false, message: '🔴 Chiave non valida' };
      }
      return { ok: false, message: `🔴 Errore connessione: ${err.message}` };
    }
  });
}

/** Propaga credenziali salvate ai servizi al boot. */
function boot({ store }) {
  try {
    const acr = store.get('acrcloud') || {};
    acrcloudService.setCredentials(acr);
  } catch { /* noop */ }
  try {
    const rt = store.get('replicateToken', '');
    if (rt) aiGenreService.setReplicateToken(rt);
  } catch (err) { console.warn('[boot] replicateToken:', err.message); }
  try {
    const c = store.get('analysisConcurrency', 3);
    analysisQueue.setConcurrency(c);
  } catch (err) { console.warn('[boot] analysisConcurrency:', err.message); }
  try {
    const mbService = require('../../services/musicbrainzService');
    if (mbService.initFromStore) mbService.initFromStore(store);
  } catch (err) { console.warn('[boot] musicbrainz init:', err.message); }
}

module.exports = { register, boot };
