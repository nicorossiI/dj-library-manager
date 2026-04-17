/**
 * wizard.js — logica UI del wizard primo avvio.
 * Comunica col main via window.wizardApi (wizard-preload.js).
 */
'use strict';

const state = {
  step: 1,
  watchFolder: '',
  acr: { host: '', key: '', secret: '' },
  acrValidated: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function gotoStep(n) {
  state.step = n;
  $$('.wiz-step').forEach(s => {
    s.classList.toggle('active', Number(s.dataset.step) === n);
  });
  $$('.wiz-dot').forEach(d => {
    const ds = Number(d.dataset.step);
    d.classList.toggle('active', ds === n);
    d.classList.toggle('done', ds < n);
  });
}

function setTestResult(kind, msg) {
  const el = $('#wiz-test-result');
  el.className = kind;
  el.textContent = msg;
}

async function pickFolder() {
  const r = await window.wizardApi.pickFolder();
  if (r?.ok && r.data) {
    state.watchFolder = r.data;
    const pEl = $('#wiz-folder-path');
    pEl.textContent = r.data;
    pEl.classList.add('has-value');
  }
}

async function testAcr() {
  const cfg = {
    host: $('#wiz-acr-host').value.trim(),
    accessKey: $('#wiz-acr-key').value.trim(),
    accessSecret: $('#wiz-acr-secret').value.trim(),
  };
  state.acr = { host: cfg.host, key: cfg.accessKey, secret: cfg.accessSecret };
  if (!cfg.host || !cfg.accessKey || !cfg.accessSecret) {
    setTestResult('err', '🔴 Compila tutti i campi');
    return;
  }
  setTestResult('wait', '⏳ Test in corso...');
  const r = await window.wizardApi.testApi(cfg);
  if (r?.ok && r.data?.online) {
    state.acrValidated = true;
    setTestResult('ok', '🟢 Funziona!');
  } else {
    state.acrValidated = false;
    const reason = r?.data?.reason || r?.error || 'Errore';
    setTestResult('err', `🔴 ${reason}`);
  }
}

function finish() {
  // Leggi acr dallo stato anche senza test (l'utente potrebbe aver compilato e non testato)
  const acr = {
    host: $('#wiz-acr-host').value.trim(),
    accessKey: $('#wiz-acr-key').value.trim(),
    accessSecret: $('#wiz-acr-secret').value.trim(),
  };
  const replicateToken = ($('#wiz-replicate-token')?.value || '').trim();
  const payload = {
    watchFolder: state.watchFolder || '',
    startWithWindows: $('#wiz-start-with-windows').checked,
    notificationsEnabled: $('#wiz-notifications').checked,
    acrcloud: (acr.host && acr.accessKey && acr.accessSecret) ? acr : null,
    replicateToken: replicateToken || null,
  };
  window.wizardApi.complete(payload);
}

function init() {
  $$('[data-goto]').forEach(btn => {
    btn.addEventListener('click', () => gotoStep(Number(btn.dataset.goto)));
  });

  $('#wiz-pick-folder').addEventListener('click', pickFolder);
  $('#wiz-test-api').addEventListener('click', testAcr);
  $('#wiz-finish').addEventListener('click', finish);

  $('#wiz-skip-acr').addEventListener('click', () => {
    $('#wiz-acr-host').value = '';
    $('#wiz-acr-key').value = '';
    $('#wiz-acr-secret').value = '';
    state.acr = { host: '', key: '', secret: '' };
    state.acrValidated = false;
    gotoStep(4);
  });

  $('#wiz-open-acr-console').addEventListener('click', (e) => {
    e.preventDefault();
    window.wizardApi.openExternal('https://console.acrcloud.com');
  });

  $('#wiz-open-replicate')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.wizardApi.openExternal('https://replicate.com/account/api-tokens');
  });

  $('#wiz-close').addEventListener('click', () => {
    // Chiudere = saltare il wizard senza completare
    window.wizardApi.skip();
  });
}

document.addEventListener('DOMContentLoaded', init);
