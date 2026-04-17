/**
 * scripts/convertModel.js
 *
 * Converte il modello DiscogsEffNet (.pb frozen GraphDef) in formato
 * TensorFlow.js (model.json + shards binari) — così @tensorflow/tfjs puro
 * può fare inferenza senza bindings nativi.
 *
 * Requisiti:
 *   - Python 3.12 (l'utente ha installato via winget)
 *   - tensorflowjs (pip install tensorflowjs)
 *
 * Uso:
 *   node scripts/convertModel.js
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const modelsDir = path.join(__dirname, '..', 'assets', 'models');
const inputPb = path.join(modelsDir, 'discogs-effnet-bs64-1.pb');
const outputDir = path.join(modelsDir, 'discogs-effnet-tfjs');

if (!fs.existsSync(inputPb)) {
  console.error('Modello .pb non trovato:', inputPb);
  console.error('Lancia prima: node scripts/downloadModels.js');
  process.exit(1);
}

if (fs.existsSync(path.join(outputDir, 'model.json'))) {
  console.log('Modello TFJS già convertito in:', outputDir);
  process.exit(0);
}

fs.mkdirSync(outputDir, { recursive: true });

// Usa lo script wrapper `tfjs_runner.py` che monkey-patcha shape_poly
// mancante nelle versioni recenti di jax e chiama il converter ufficiale.
function resolveConverter() {
  const wrapper = path.join(__dirname, 'tfjs_runner.py');
  // Py 3.11 preferito (stack TF 2.15 + tfjs 4.10 stabile)
  return { cmd: 'py', args: ['-3.11', wrapper] };
}

const { cmd, args: baseArgs } = resolveConverter();

// Stub locale di tensorflow_decision_forests (tensorflowjs lo importa
// unconditionally anche se il nostro modello non lo usa)
const stubDir = path.join(__dirname, 'tfdf_stub');
const env = { ...process.env };
env.PYTHONPATH = env.PYTHONPATH
  ? `${stubDir}${path.delimiter}${env.PYTHONPATH}`
  : stubDir;

console.log('Conversione modello DiscogsEffNet...');
console.log('  Input:', inputPb);
console.log('  Output:', outputDir);
console.log('  Converter:', cmd, baseArgs.join(' '));
console.log('  PYTHONPATH:', env.PYTHONPATH);

const convArgs = [
  ...baseArgs,
  '--input_format=tf_frozen_model',
  '--output_format=tfjs_graph_model',
  '--output_node_names=PartitionedCall',
  '--skip_op_check',
  inputPb,
  outputDir,
];

const r = spawnSync(cmd, convArgs, { stdio: 'inherit', shell: false, env });
if (r.status !== 0) {
  console.error('\nConversione fallita (exit ' + r.status + ').');
  console.error('Riprova senza --output_node_names (autodetect):');
  const retry = spawnSync(cmd, [
    ...baseArgs,
    '--input_format=tf_frozen_model',
    '--output_format=tfjs_graph_model',
    inputPb,
    outputDir,
  ], { stdio: 'inherit', shell: false, env });
  if (retry.status !== 0) {
    process.exit(retry.status || 1);
  }
}

// Riepilogo files generati
try {
  const files = fs.readdirSync(outputDir);
  const totalBytes = files.reduce((a, f) => a + fs.statSync(path.join(outputDir, f)).size, 0);
  console.log('\nConversione completata!');
  console.log('  File generati:', files.length);
  console.log('  Dimensione totale:', (totalBytes / 1024 / 1024).toFixed(1), 'MB');
  for (const f of files) console.log('   ·', f);
} catch { /* noop */ }
