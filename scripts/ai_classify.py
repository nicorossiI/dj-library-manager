"""
scripts/ai_classify.py — inferenza DiscogsEffNet per un file audio.

Pipeline:
  1. ffmpeg decodifica audio → WAV mono 16kHz PCM 16-bit
  2. TF computa mel-spectrogram (128 frames × 96 bands) replicando params essentia
  3. Inferenza modello .pb → 400 probabilità Discogs genres
  4. Mappa top-k → JSON su stdout

Uso:
    py -3.11 scripts/ai_classify.py <audio_file> [--k 5]

Output JSON su stdout:
    {"ok": true, "top": [{"label":"Afro House","score":0.74}, ...],
     "genre_mapped": "afrohouse", "confidence": 74}

Exit 0 se successo, 1 se errore (stderr ha dettaglio).
"""
import sys
import os
import json
import tempfile
import subprocess

# Silenziamo i log TF (troppi WARNINGs)
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['TF_ENABLE_ONEDNN_OPTS'] = '0'

import numpy as np
import tensorflow as tf

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(SCRIPT_DIR, '..', 'assets', 'models')
MODEL_PB = os.path.join(MODELS_DIR, 'discogs-effnet-bs64-1.pb')
MODEL_META = os.path.join(MODELS_DIR, 'discogs-effnet-bs64-1.json')

# Essentia DiscogsEffNet preprocessing parametri (da metadata Essentia):
SAMPLE_RATE = 16000
FRAME_SIZE = 512
HOP_SIZE = 256
MEL_BANDS = 96
MEL_FRAMES = 128      # frames per spettrogramma (patch length)
LOW_FREQ_HZ = 0
HIGH_FREQ_HZ = 8000
BATCH_SIZE = 64       # il modello vuole shape [64, 128, 96]

# Mappa da genere Discogs → nostri generi interni.
# I labels DiscogsEffNet sono in formato "Parent---Sub" (es. "Electronic---Techno",
# "Latin---Reggaeton"). La match è fatta in 3 passi: exact → sub esatto → parent.
DISCOGS_TO_GENRE = {
    # House family
    'afro house':     'afrohouse',
    'afro-house':     'afrohouse',
    'afrobeat':       'afrohouse',
    'afrobeats':      'afrohouse',
    'tribal house':   'afrohouse',
    'tech house':     'techhouse',
    'deep house':     'deephouse',
    'funky house':    'house',
    'disco house':    'house',
    'jackin house':   'house',
    'house':          'house',
    'progressive house': 'house',
    # Latin
    'reggaeton':      'reggaeton',
    'reggae':         'reggaeton',
    'latin hip-hop':  'reggaeton',
    'latin':          'reggaeton',
    'dembow':         'dembow',
    'mambo':          'dembow',
    'bachata':        'bachata',
    'salsa':          'salsa',
    'tropical':       'salsa',
    'cumbia':         'salsa',
    'merengue':       'salsa',
    # Hip hop / rap
    'hip hop':        'hiphop',
    'hip-hop':        'hiphop',
    'rap':            'hiphop',
    'trap':           'hiphop',
    'gangsta':        'hiphop',
    'boom bap':       'hiphop',
    # Electronic standalone
    'techno':         'techno',
    'minimal':        'techno',
    'trance':         'trance',
    'drum n bass':    'dnb',
    'drum & bass':    'dnb',
    'drum and bass':  'dnb',
    'dubstep':        'dubstep',
    'garage':         'dubstep',
    # Pop
    'pop':            'pop',
    'synth-pop':      'pop',
    'synthpop':       'pop',
}



def find_ffmpeg():
    # ffmpeg-static bundlato in node_modules
    candidates = [
        os.path.join(SCRIPT_DIR, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
        os.path.join(SCRIPT_DIR, '..', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
        'ffmpeg',
    ]
    for c in candidates:
        if c == 'ffmpeg' or os.path.exists(c):
            return c
    raise RuntimeError('ffmpeg non trovato')


def decode_audio(path):
    """ffmpeg → WAV 16kHz mono PCM 16-bit, letto in np.float32 [-1,1]."""
    ff = find_ffmpeg()
    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    tmp.close()
    try:
        subprocess.check_call(
            [ff, '-y', '-v', 'error', '-i', path,
             '-ar', str(SAMPLE_RATE), '-ac', '1',
             '-sample_fmt', 's16', '-f', 'wav', tmp.name],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        raw = tf.io.read_file(tmp.name)
        audio, sr = tf.audio.decode_wav(raw, desired_channels=1)
        return tf.squeeze(audio, axis=-1).numpy().astype(np.float32)
    finally:
        try: os.unlink(tmp.name)
        except Exception: pass


def compute_mel_spectrogram(audio):
    """
    Replica essentia MonoLoader + TensorflowPredictEffnetDiscogs preprocessing:
      STFT finestre 512, hop 256, 96 mel bands 0-8000 Hz, log(1+x).
    Ritorna array shape [N_patches, MEL_FRAMES, MEL_BANDS] (batched).
    """
    audio_t = tf.constant(audio)
    stft = tf.signal.stft(
        audio_t, frame_length=FRAME_SIZE, frame_step=HOP_SIZE,
        fft_length=FRAME_SIZE, pad_end=True,
    )
    mag = tf.abs(stft)
    # Mel filterbank compat Essentia (HTK mel scale)
    num_spec_bins = FRAME_SIZE // 2 + 1
    mel_weights = tf.signal.linear_to_mel_weight_matrix(
        num_mel_bins=MEL_BANDS,
        num_spectrogram_bins=num_spec_bins,
        sample_rate=SAMPLE_RATE,
        lower_edge_hertz=LOW_FREQ_HZ,
        upper_edge_hertz=HIGH_FREQ_HZ,
    )
    mel = tf.matmul(mag, mel_weights)
    # Essentia formula esatta: log10(1 + 10000 * mel). NON normalizzato.
    log_mel = tf.math.log(1.0 + mel * 10000.0) / tf.math.log(tf.constant(10.0))
    log_mel = log_mel.numpy().astype(np.float32)

    # Split in patch di MEL_FRAMES frames (128 each)
    total = log_mel.shape[0]
    n_patches = max(1, total // MEL_FRAMES)
    patches = []
    for i in range(n_patches):
        s = i * MEL_FRAMES
        e = s + MEL_FRAMES
        if e > total:
            # padding finale
            pad = np.zeros((MEL_FRAMES, MEL_BANDS), dtype=np.float32)
            pad[:total - s] = log_mel[s:total]
            patches.append(pad)
        else:
            patches.append(log_mel[s:e])
    return np.stack(patches, axis=0)  # [N, 128, 96]


def load_graph(pb_path):
    with tf.io.gfile.GFile(pb_path, 'rb') as f:
        gd = tf.compat.v1.GraphDef()
        gd.ParseFromString(f.read())
    g = tf.Graph()
    with g.as_default():
        tf.compat.v1.import_graph_def(gd, name='')
    return g


def load_labels():
    if not os.path.exists(MODEL_META):
        return None
    with open(MODEL_META, 'r', encoding='utf-8') as f:
        m = json.load(f)
    # Essentia JSON mette le classi in "classes" o "output.classes"
    if 'classes' in m and isinstance(m['classes'], list):
        return m['classes']
    if 'output' in m and isinstance(m['output'], dict) and 'classes' in m['output']:
        return m['output']['classes']
    return None


def classify(audio_path, k=5):
    if not os.path.exists(audio_path):
        raise FileNotFoundError(audio_path)
    if not os.path.exists(MODEL_PB):
        raise FileNotFoundError(f'Modello non presente: {MODEL_PB}')

    audio = decode_audio(audio_path)
    if audio.size < SAMPLE_RATE * 5:
        raise RuntimeError('Audio troppo corto (<5s)')

    # Prendi 30s dal centro — aiuta a saltare intro silenziose
    max_samples = SAMPLE_RATE * 30
    if len(audio) > max_samples:
        start = (len(audio) - max_samples) // 2
        audio = audio[start:start + max_samples]

    patches = compute_mel_spectrogram(audio)  # [N, 128, 96]

    # Pad / truncate al BATCH_SIZE del modello (64)
    N = patches.shape[0]
    if N < BATCH_SIZE:
        pad = np.zeros((BATCH_SIZE - N, MEL_FRAMES, MEL_BANDS), dtype=np.float32)
        batch = np.concatenate([patches, pad], axis=0)
        valid = N
    else:
        batch = patches[:BATCH_SIZE]
        valid = BATCH_SIZE

    # Inferenza
    graph = load_graph(MODEL_PB)
    with tf.compat.v1.Session(graph=graph) as sess:
        inp = graph.get_tensor_by_name('serving_default_melspectrogram:0')
        out = graph.get_tensor_by_name('PartitionedCall:0')
        preds = sess.run(out, feed_dict={inp: batch})  # [64, 400]

    # Media le predictions sui patch validi
    preds = preds[:valid]
    mean_preds = np.mean(preds, axis=0)  # [400]

    # Top-k
    labels = load_labels() or [f'class_{i}' for i in range(mean_preds.shape[0])]
    top_idx = np.argsort(mean_preds)[::-1][:k]
    top = [
        {'label': labels[i] if i < len(labels) else f'class_{i}',
         'score': float(mean_preds[i])}
        for i in top_idx
    ]

    # Mappa a nostro genere interno.
    # Labels DiscogsEffNet sono "Parent---Sub" (es. "Electronic---Techno").
    # Priorità: exact label → sub esatto → parent esatto → substring anywhere.
    def find_mapping(label: str):
        key = label.lower().strip()
        if key in DISCOGS_TO_GENRE:
            return DISCOGS_TO_GENRE[key]
        if '---' in key:
            parent, sub = key.split('---', 1)
            parent = parent.strip()
            sub = sub.strip()
            if sub in DISCOGS_TO_GENRE:
                return DISCOGS_TO_GENRE[sub]
            if parent in DISCOGS_TO_GENRE:
                return DISCOGS_TO_GENRE[parent]
        # substring any
        for k2, v2 in DISCOGS_TO_GENRE.items():
            if k2 in key:
                return v2
        return None

    # Blacklist: labels che tipicamente escono quando il preprocessing
    # non è perfettamente allineato a Essentia → spesso falsi positivi.
    NOISE_SUBS = {'noise', 'speedcore', 'experimental', 'abstract',
                  'rhythmic noise', 'hardcore', 'industrial'}
    # Soglia minima di confidenza per considerare il risultato affidabile
    MIN_SCORE = 0.30

    mapped = None
    confidence = 0
    for t in top:
        score = t['score']
        label = t['label'].lower().strip()
        # Salta labels noise/experimental sotto soglia alta
        sub = label.split('---', 1)[-1].strip() if '---' in label else label
        if sub in NOISE_SUBS and score < 0.50:
            continue
        if score < MIN_SCORE:
            continue
        m = find_mapping(t['label'])
        if m:
            mapped = m
            confidence = int(round(score * 100))
            break

    return {
        'ok': True,
        'top': top,
        'genre_mapped': mapped,
        'confidence': confidence,
    }


if __name__ == '__main__':
    argv = sys.argv[1:]
    if not argv:
        print(json.dumps({'ok': False, 'error': 'usage: ai_classify.py <file> [--k 5]'}))
        sys.exit(1)
    k = 5
    audio_path = argv[0]
    if '--k' in argv:
        try:
            k = int(argv[argv.index('--k') + 1])
        except Exception:
            pass
    try:
        result = classify(audio_path, k=k)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
        sys.exit(1)
