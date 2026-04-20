/**
 * src/utils/runProc.js
 *
 * Esegue un processo child con:
 *   - timeout hard (SIGKILL)
 *   - cleanup garantito dei listener su stdout/stderr
 *   - cancellazione di eventuali temp file in ogni code path
 *
 * Fix per il memory leak osservato in audit v1.3.2: `spawn` senza
 * rimozione listener, su 500+ MP3 con file corrotti/permission
 * denied, accumula listener fantasmi e file temp orfani.
 *
 * API:
 *   runProc(cmd, args, {
 *     timeout = 30000,   ms — default 30s
 *     tmpFiles = [],     file da cancellare alla fine (success o fail)
 *     onData   = null,   callback(chunk:string) su ogni stdout chunk
 *     input    = null,   Buffer/string da scrivere su stdin
 *     encoding = 'utf8', usato solo per le callback; buffer sempre raw
 *   }) → Promise<{ stdout, stderr, code }>
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

function cleanupTmp(files) {
  for (const f of files || []) {
    try {
      if (f && fs.existsSync(f)) {
        const stat = fs.statSync(f);
        if (stat.isDirectory()) fs.rmSync(f, { recursive: true, force: true });
        else fs.unlinkSync(f);
      }
    } catch { /* noop */ }
  }
}

function runProc(cmd, args = [], opts = {}) {
  const {
    timeout = 30000,
    tmpFiles = [],
    onData = null,
    input = null,
    encoding = 'utf8',
    spawnOptions = {},
  } = opts;

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { windowsHide: true, ...spawnOptions });
    } catch (err) {
      cleanupTmp(tmpFiles);
      return reject(err);
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const finalize = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.stdout?.removeAllListeners(); } catch { /* noop */ }
      try { proc.stderr?.removeAllListeners(); } catch { /* noop */ }
      try { proc.removeAllListeners(); } catch { /* noop */ }
      cleanupTmp(tmpFiles);
      fn();
    };

    const timer = setTimeout(() => {
      finalize(() => {
        try { proc.kill('SIGKILL'); } catch { /* noop */ }
        reject(new Error(`Timeout ${timeout}ms: ${cmd} ${(args || []).join(' ')}`));
      });
    }, timeout);

    proc.stdout?.on('data', (d) => {
      stdoutChunks.push(d);
      if (onData) {
        try { onData(d.toString(encoding)); } catch { /* noop */ }
      }
    });
    proc.stderr?.on('data', (d) => { stderrChunks.push(d); });

    proc.on('error', (err) => {
      finalize(() => reject(err));
    });

    proc.on('close', (code) => {
      finalize(() => {
        const stdout = Buffer.concat(stdoutChunks);
        const stderr = Buffer.concat(stderrChunks);
        if (code === 0) {
          resolve({
            stdout: stdout.toString(encoding),
            stderr: stderr.toString(encoding),
            stdoutBuffer: stdout,
            stderrBuffer: stderr,
            code,
          });
        } else {
          const errText = stderr.toString(encoding).slice(-400);
          reject(new Error(`Exit ${code}: ${cmd} — ${errText}`));
        }
      });
    });

    if (input != null) {
      try {
        proc.stdin?.end(input);
      } catch (err) {
        finalize(() => reject(err));
      }
    }
  });
}

module.exports = { runProc };
