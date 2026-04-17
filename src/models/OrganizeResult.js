/**
 * src/models/OrganizeResult.js
 *
 * Risultato dell'operazione di organizzazione cartelle:
 * file spostati/copiati, saltati, errori, path root output e path rekordbox.xml.
 *
 * Esporta: OrganizeResult
 */

'use strict';

class OrganizeResult {
  constructor() {
    this.moved = [];      // [{ from, to, track }]
    this.skipped = [];    // [{ filePath, reason }]
    this.errors = [];     // [{ filePath, error }]
    this.destRoot = '';
    this.rekordboxXmlPath = '';
    this.startedAt = Date.now();
    this.finishedAt = null;
  }

  addMoved(from, to, track) {
    this.moved.push({ from, to, track });
  }

  addSkipped(filePath, reason) {
    this.skipped.push({ filePath, reason });
  }

  addError(filePath, error) {
    this.errors.push({ filePath, error: String(error?.message || error) });
  }

  finalize() {
    this.finishedAt = Date.now();
    return this;
  }

  get summary() {
    return {
      moved: this.moved.length,
      skipped: this.skipped.length,
      errors: this.errors.length,
      destRoot: this.destRoot,
      rekordboxXmlPath: this.rekordboxXmlPath,
      elapsedMs: (this.finishedAt || Date.now()) - this.startedAt,
    };
  }

  toJSON() { return { ...this, summary: this.summary }; }
}

module.exports = OrganizeResult;
