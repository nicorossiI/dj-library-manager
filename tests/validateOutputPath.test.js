/**
 * tests/validateOutputPath.test.js
 *
 * Test unitari per validateOutputPath — guardia anti-root-disco e
 * anti-cartella-di-sistema sui path che riceviamo dall'utente.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateOutputPath } = require('../src/main/handlers/shared');

test('validateOutputPath: path vuoto → errore', () => {
  assert.match(validateOutputPath(''), /non specificato/i);
  assert.match(validateOutputPath(null), /non specificato/i);
  assert.match(validateOutputPath(undefined), /non specificato/i);
  assert.match(validateOutputPath('   '), /non specificato/i);
});

test('validateOutputPath: root disco Windows → errore', () => {
  assert.match(validateOutputPath('C:\\'), /root del disco/i);
  assert.match(validateOutputPath('D:\\'), /root del disco/i);
  assert.match(validateOutputPath('Z:\\'), /root del disco/i);
  assert.match(validateOutputPath('C:'), /root del disco/i);
  assert.match(validateOutputPath('C:/'), /root del disco/i);
});

test('validateOutputPath: root disco Unix → errore', () => {
  // path.resolve('/') === '/' solo su Unix; su Windows diventa la root corrente.
  if (process.platform !== 'win32') {
    assert.match(validateOutputPath('/'), /root del disco/i);
  }
});

test('validateOutputPath: cartelle di sistema Windows → errore', () => {
  if (process.platform === 'win32') {
    assert.match(validateOutputPath('C:\\Windows'), /sistema non consentita/i);
    assert.match(validateOutputPath('C:\\Windows\\System32'), /sistema non consentita/i);
    assert.match(validateOutputPath('C:\\Program Files\\App'), /sistema non consentita/i);
    assert.match(validateOutputPath('C:\\Program Files (x86)'), /sistema non consentita/i);
  }
});

test('validateOutputPath: path valido esistente → null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djlm-validate-'));
  try {
    assert.equal(validateOutputPath(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateOutputPath: path inesistente con mustExist=true → errore', () => {
  const fake = path.join(os.tmpdir(), 'djlm-doesnt-exist-' + Date.now());
  assert.match(validateOutputPath(fake), /non trovata/i);
});

test('validateOutputPath: path inesistente con mustExist=false → null', () => {
  const fake = path.join(os.tmpdir(), 'djlm-doesnt-exist-' + Date.now());
  assert.equal(validateOutputPath(fake, { mustExist: false }), null);
});

test('validateOutputPath: case-insensitive per system folders', () => {
  if (process.platform === 'win32') {
    assert.match(validateOutputPath('c:\\windows'), /sistema non consentita/i);
    assert.match(validateOutputPath('C:\\WINDOWS\\System32'), /sistema non consentita/i);
  }
});
