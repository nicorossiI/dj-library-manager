/**
 * src/services/analysisQueue.js
 *
 * Pool di worker CONDIVISO tra:
 *   - analysis:start (pipeline FAI TUTTO)
 *   - library:analyzeFull (legacy)
 *   - watcher (bulk-add automatico dalla cartella monitorata)
 *
 * Risolve 3 problemi concreti:
 *   1. Race condition: due chiamate simultanee (es. analisi manuale + watcher)
 *      si contendevano `appState.loadedTracks` con mutations non atomiche.
 *   2. Bulk-add: chokidar che emette 50 `add` events → 50 pipeline async in
 *      parallelo → Shazam/ACR rate-limit cascata.
 *   3. UX: l'utente non ha controllo sulla velocità/precisione dell'analisi.
 *
 * API:
 *   enqueue(fn, label)             → Promise (fn async viene eseguita quando
 *                                    c'è uno slot libero)
 *   drain()                        → aspetta svuotamento totale coda
 *   clear()                        → rimuove task pendenti (utente cancella)
 *   getStats()                     → { pending, size, totalEnqueued, totalCompleted }
 *   setProgressCallback(fn)        → fn viene chiamata ad ogni task completato
 *   setConcurrency(n)              → runtime change (preset Fast/Normal/Precise)
 *
 * Dipendenze: p-queue@6 (CJS). NON usare dynamic import.
 */

'use strict';

// p-queue v6 è CommonJS; default export sta su module.exports.default
const PQueueMod = require('p-queue');
const PQueue = PQueueMod.default || PQueueMod;

const queue = new PQueue({ concurrency: 3 });

let _onProgress = null;
let _totalEnqueued = 0;
let _totalCompleted = 0;

function setProgressCallback(fn) {
  _onProgress = typeof fn === 'function' ? fn : null;
}

function getStats() {
  return {
    pending: queue.pending,     // in esecuzione adesso
    size: queue.size,           // in attesa di uno slot
    concurrency: queue.concurrency,
    totalEnqueued: _totalEnqueued,
    totalCompleted: _totalCompleted,
  };
}

/**
 * Accoda un task. Il `label` è usato solo per il callback progress (logging).
 * Ritorna una Promise che risolve col risultato di `fn`, o rigetta con l'errore.
 * NB: anche in caso di errore incrementiamo totalCompleted perché "completato"
 * = uscito dalla coda, non necessariamente riuscito.
 */
function enqueue(fn, label = '') {
  _totalEnqueued++;
  return queue.add(async () => {
    try {
      const result = await fn();
      return result;
    } finally {
      _totalCompleted++;
      if (_onProgress) {
        try {
          _onProgress({
            label,
            completed: _totalCompleted,
            total: _totalEnqueued,
            pending: queue.pending + queue.size,
          });
        } catch { /* callback errors non devono rompere il worker */ }
      }
    }
  });
}

async function drain() {
  await queue.onIdle();
}

function clear() {
  queue.clear();
  _totalEnqueued = 0;
  _totalCompleted = 0;
}

function setConcurrency(n) {
  const v = Math.max(1, Math.min(Number(n) || 1, 8));
  queue.concurrency = v;
  return v;
}

module.exports = {
  enqueue,
  drain,
  clear,
  getStats,
  setProgressCallback,
  setConcurrency,
};
