// Wairua Scribe Live — motor de reconocimiento para subtítulos en directo.
// Recibe ventanas cortas de audio (16 kHz mono) y devuelve su texto.

const LOCAL_LIB = new URL('./vendor/transformers.min.js', import.meta.url).href;
const LOCAL_WASM = new URL('./vendor/', import.meta.url).href;
const CDN_LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

let lib = null, asr = null, device = 'wasm';
const post = (type, d = {}) => self.postMessage({ type, ...d });

const GHOSTS = [
  /subt[ií]tulos (realizados|creados|hechos) por/i, /amara\.org/i,
  /gracias por (ver|mirar)/i, /suscr[ií]bete/i, /no olvides suscribirte/i,
  /thanks? (you )?for watching/i, /^\s*(m[uú]sica|\[.*?\]|\(.*?\)|♪+|\.+|-+)\s*$/i,
];
const clean = t => {
  t = (t || '').replace(/\s+/g, ' ').trim();
  if (!t || GHOSTS.some(r => r.test(t))) return '';
  return t;
};

async function getLib() {
  if (lib) return lib;
  try { lib = await import(LOCAL_LIB); lib.env.backends.onnx.wasm.wasmPaths = LOCAL_WASM; }
  catch { lib = await import(CDN_LIB); }
  lib.env.allowLocalModels = false;
  return lib;
}

async function gpuOK() {
  try {
    const a = await self.navigator?.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    return !!a && !(a.info?.isFallbackAdapter ?? a.isFallbackAdapter);
  } catch { return false; }
}

async function load({ model, proc }) {
  const { pipeline } = await getLib();
  device = proc !== 'wasm' && await gpuOK() ? 'webgpu' : 'wasm';
  let cached = false;
  try {
    const need = device === 'webgpu' ? ['encoder_model.onnx', 'decoder_model_merged_q4.onnx'] : ['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx'];
    const urls = (await (await caches.open('transformers-cache')).keys()).map(r => r.url);
    cached = need.every(f => urls.some(u => u.includes('/' + model + '/') && u.endsWith('/onnx/' + f)));
  } catch {}
  const files = new Map();
  const progress_callback = p => {
    if (p.status === 'progress' && p.file) {
      files.set(p.file, { l: p.loaded || 0, t: p.total || 0 });
      let l = 0, t = 0; for (const f of files.values()) { l += f.l; t += f.t; }
      post('progress', { pct: t ? l / t * 100 : 0, loaded: l, total: t, cached });
    }
  };
  const dtype = device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';
  try {
    asr = await pipeline('automatic-speech-recognition', model, { device, dtype, progress_callback });
  } catch (e) {
    if (device !== 'webgpu') throw e;
    console.warn('[Live] WebGPU falló, se usa CPU', e);
    device = 'wasm';
    asr = await pipeline('automatic-speech-recognition', model, { device, dtype: 'q8', progress_callback });
  }
  // Calentamiento: la primera inferencia compila los shaders y es lenta.
  post('warming', { device });
  await asr(new Float32Array(16000), { language: 'spanish', task: 'transcribe' });
  post('ready', { device });
}

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'load') await load(m);
    else if (m.type === 'run') {
      const t0 = performance.now();
      const opts = { task: 'transcribe', max_new_tokens: 96 };
      if (m.language && m.language !== 'auto') opts.language = m.language;
      const out = await asr(m.audio, opts);
      post('result', { id: m.id, text: clean(out.text), ms: performance.now() - t0 });
    }
  } catch (e) {
    console.error('[Live] Error', e);
    post('error', { detail: String(e?.message || e) });
  }
};
