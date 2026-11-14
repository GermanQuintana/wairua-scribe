// Wairua Scribe — motor de transcripción en un Web Worker.
// Se ejecuta fuera del hilo principal: la página no se congela durante
// la transcripción y el audio nunca sale del navegador.

// Biblioteca servida desde el propio sitio (carpeta vendor/). Si faltara,
// se recurre a la misma versión en jsDelivr.
const LOCAL_LIB = new URL('./vendor/transformers.min.js', import.meta.url).href;
const LOCAL_WASM = new URL('./vendor/', import.meta.url).href;
const CDN_LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
const SR = 16000;

let lib = null;
let transcriber = null;
let loadedKey = '';

const post = (type, data = {}) => self.postMessage({ type, ...data });

// Frases que Whisper "alucina" en silencios o ruido (muy típicas en español)
const GHOSTS = [
  /subt[ií]tulos (realizados|creados|hechos) por/i,
  /amara\.org/i,
  /gracias por (ver|mirar) (el|este) v[ií]deo/i,
  /suscr[ií]bete/i,
  /no olvides suscribirte/i,
  /^\s*(m[uú]sica|\[m[uú]sica\]|♪+)\s*$/i,
  /^\s*\.+\s*$/,
  /thanks? (you )?for watching/i,
];
const isGhost = s => GHOSTS.some(r => r.test(s));

async function getLib() {
  if (lib) return lib;
  try {
    lib = await import(LOCAL_LIB);
    lib.env.backends.onnx.wasm.wasmPaths = LOCAL_WASM;
  } catch (e) {
    console.warn('[Scribe] vendor/ no disponible, se usa jsDelivr', e);
    try { lib = await import(CDN_LIB); } catch { throw new Error('NET_LIB'); }
  }
  lib.env.allowLocalModels = false;
  lib.env.useBrowserCache = true;
  return lib;
}

async function hasWebGPU() {
  try {
    if (!self.navigator?.gpu) return false;
    const a = await self.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    // Un adaptador "fallback" es una GPU emulada por software: no acelera nada.
    return !!a && !(a.info?.isFallbackAdapter ?? a.isFallbackAdapter);
  } catch { return false; }
}

async function load(model, device) {
  const key = model + '|' + device;
  if (transcriber && loadedKey === key) return;
  if (transcriber) { try { await transcriber.dispose(); } catch {} transcriber = null; loadedKey = ''; }

  const { pipeline } = await getLib();
  const files = new Map();
  const progress_callback = p => {
    if (p.status === 'progress' && p.file) {
      files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
      let l = 0, t = 0;
      for (const f of files.values()) { l += f.loaded; t += f.total; }
      post('load-progress', { progress: t ? (l / t) * 100 : 0, loaded: l, total: t });
    } else if (p.status === 'ready') {
      post('load-progress', { progress: 100 });
    }
  };

  // WebGPU: el codificador en fp32 y el decodificador cuantizado q4 es la
  // combinación estable recomendada para Whisper. En CPU, q8 en todo.
  const dtype = device === 'webgpu'
    ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
    : 'q8';

  transcriber = await pipeline('automatic-speech-recognition', model, { device, dtype, progress_callback });
  loadedKey = key;
}

// Divide el audio en bloques de ~90 s cortando en el punto más silencioso
// cercano, para dar progreso real, texto parcial y menos memoria.
function splitBlocks(audio, target = 90, search = 8) {
  const n = audio.length, blocks = [];
  let start = 0;
  const win = Math.floor(SR / 10);
  while (start < n) {
    let end = Math.min(n, start + target * SR);
    if (n - end < 20 * SR) end = n; // no dejar colas diminutas
    if (end < n) {
      const a = Math.max(start + 30 * SR, end - search * SR);
      const b = Math.min(n - win, end + search * SR);
      let best = end, bestE = Infinity;
      for (let i = a; i < b; i += win) {
        let e = 0;
        for (let j = i; j < i + win; j++) e += audio[j] * audio[j];
        if (e < bestE) { bestE = e; best = i + (win >> 1); }
      }
      end = best;
    }
    blocks.push([start, end]);
    start = end;
  }
  return blocks;
}

function rms(a) {
  let s = 0; const step = 4;
  for (let i = 0; i < a.length; i += step) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, a.length / step));
}

async function transcribe({ audio, model, language, processor }) {
  const started = performance.now();

  // 1) Elegir dispositivo
  let device = 'wasm';
  if (processor !== 'wasm') {
    const gpu = await hasWebGPU();
    if (gpu) device = 'webgpu';
    else if (processor === 'webgpu') throw new Error('NO_GPU');
    else post('notice', { code: 'gpu-fallback' });
  }

  // 2) Cargar modelo (con plan B en CPU)
  post('stage', { stage: 'load', device });
  try {
    await load(model, device);
  } catch (e) {
    if (e.message === 'NET_LIB') throw e;
    if (device === 'webgpu') {
      console.warn('[Scribe] WebGPU falló al cargar, se usa CPU', e);
      post('notice', { code: 'gpu-load-failed', detail: String(e?.message || e) });
      device = 'wasm';
      post('stage', { stage: 'load', device });
      await load(model, device);
    } else throw e;
  }

  // 3) Transcribir por bloques
  const opts = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, task: 'transcribe' };
  if (language && language !== 'auto') opts.language = language;

  const blocks = splitBlocks(audio);
  const duration = audio.length / SR;
  post('stage', { stage: 'transcribe', device, blocks: blocks.length, duration });

  const allChunks = [];
  for (let i = 0; i < blocks.length; i++) {
    const [s, e] = blocks[i];
    const seg = audio.subarray(s, e);
    const offset = s / SR;
    if (seg.length < SR * 0.4 || rms(seg) < 0.0015) {
      post('progress', { done: i + 1, total: blocks.length, position: e / SR, duration, chunks: [] });
      continue;
    }
    let out;
    try {
      out = await transcriber(seg, opts);
    } catch (err) {
      if (device !== 'webgpu') throw err;
      console.warn('[Scribe] WebGPU falló al transcribir, se reintenta en CPU', err);
      post('notice', { code: 'gpu-run-failed', detail: String(err?.message || err) });
      device = 'wasm';
      post('stage', { stage: 'load', device });
      await load(model, device);
      post('stage', { stage: 'transcribe', device, blocks: blocks.length, duration });
      out = await transcriber(seg, opts);
    }
    const raw = Array.isArray(out) ? out[0] : out;
    let chunks = (raw.chunks && raw.chunks.length)
      ? raw.chunks.map(c => ({
          start: (c.timestamp?.[0] ?? 0) + offset,
          end: (c.timestamp?.[1] ?? (e - s) / SR) + offset,
          text: (c.text || '').trim(),
        }))
      : [{ start: offset, end: e / SR, text: (raw.text || '').trim() }];
    chunks = chunks.filter(c => c.text && !isGhost(c.text));
    // eliminar repeticiones consecutivas idénticas (bucle típico de Whisper)
    chunks = chunks.filter((c, k) => k === 0 || c.text !== chunks[k - 1].text);
    allChunks.push(...chunks);
    post('progress', { done: i + 1, total: blocks.length, position: e / SR, duration, chunks });
  }

  post('done', { chunks: allChunks, device, seconds: (performance.now() - started) / 1000, duration });
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'transcribe') return;
  try {
    await transcribe(data);
  } catch (e) {
    console.error('[Scribe] Error en el worker', e);
    post('error', { code: e?.message || 'UNKNOWN', detail: String(e?.stack || e?.message || e) });
  }
};
