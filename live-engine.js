// Wairua Scribe — motor de transcripción en directo (compartido)
// Lo usan la página de subtítulos (live.html) y la grabadora del
// transcriptor (index.html).
//
// Flujo: AudioWorklet → paso bajo + remuestreo a 16 kHz → detector de voz
// con suelo de ruido adaptativo → transcripción repetida de la ventana
// actual (texto provisional) → confirmación en cada pausa o, como máximo,
// cada ~11 s, cortando en el punto más silencioso.

export const SR = 16000;
const CFG = { minRun: 0.9, maxWin: 11, tailSilence: 0.55, frame: 0.1 };

class Buf {
  constructor() { this.d = new Float32Array(SR * 30); this.n = 0; }
  push(x) {
    if (this.n + x.length > this.d.length) {
      const nd = new Float32Array(Math.max(this.d.length * 2, this.n + x.length));
      nd.set(this.d.subarray(0, this.n)); this.d = nd;
    }
    this.d.set(x, this.n); this.n += x.length;
  }
  view(len = this.n) { return this.d.subarray(0, len); }
  drop(k) { k = Math.min(k, this.n); this.d.copyWithin(0, k, this.n); this.n -= k; }
}

class Resampler {
  constructor(inRate) {
    this.ratio = inRate / SR; this.pos = 0; this.last = 0; this.y = 0;
    this.a = 1 - Math.exp(-2 * Math.PI * 7000 / inRate); // paso bajo ~7 kHz (antialiasing)
  }
  process(x) {
    if (this.ratio === 1) return x;
    for (let i = 0; i < x.length; i++) { this.y += this.a * (x[i] - this.y); x[i] = this.y; }
    const out = new Float32Array(Math.ceil((x.length - this.pos) / this.ratio) + 1);
    let p = this.pos, k = 0;
    while (p < x.length - 1) {
      const i = Math.floor(p), f = p - i, a = i < 0 ? this.last : x[i], b = x[i + 1];
      out[k++] = a + (b - a) * f; p += this.ratio;
    }
    this.pos = p - x.length; this.last = x[x.length - 1];
    return out.subarray(0, k);
  }
}

const rms = (a, s = 0, e = a.length) => { let t = 0; for (let i = s; i < e; i++) t += a[i] * a[i]; return Math.sqrt(t / Math.max(1, e - s)); };

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor(){ super(); this.b = new Float32Array(2048); this.n = 0; }
  process(inputs){
    const ch = inputs[0];
    if (ch && ch.length) {
      const L = ch[0].length, C = ch.length;
      for (let i = 0; i < L; i++) {
        let s = 0; for (let c = 0; c < C; c++) s += ch[c][i];
        this.b[this.n++] = s / C;
        if (this.n === this.b.length) { this.port.postMessage(this.b); this.b = new Float32Array(2048); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('wairua-tap', Tap);`;

const elementSources = new WeakMap(); // createMediaElementSource solo puede llamarse una vez por elemento

export class LiveEngine {
  /**
   * handlers: onPartial(text), onFinal({start,end,text}), onState(text),
   * onMetrics({ms, lag}), onProgress({pct, loaded, total}), onWarming(device),
   * onReady(device), onError(message)
   */
  constructor(handlers = {}, { mock = false } = {}) {
    this.h = handlers; this.mock = mock;
    this.ctx = null; this.tap = null; this.node = null;
    this.worker = null; this.ready = false; this.key = ''; this.device = null;
    this.language = 'spanish';
    this.buf = new Buf(); this.running = false; this.busy = false; this.pending = null; this.runId = 0;
    this.total = 0; this.winStart = 0; this.noise = 0.008; this.partial = ''; this.lastFinal = '';
    this.recent = new Float32Array(SR * 3); this.recentPos = 0;
  }

  /* ---------- Modelo ---------- */
  load({ model, proc }) {
    const key = model + '|' + proc;
    if (this.worker && this.key === key) return this.loading;
    this.worker?.terminate(); this.ready = false; this.key = key;
    this.worker = this.mock ? mockWorker() : new Worker(new URL('./live-worker.js', import.meta.url), { type: 'module' });
    this.loading = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data: m }) => this.onWorker(m, resolve, reject);
      this.worker.onerror = e => { const msg = 'El motor se ha detenido: ' + (e.message || 'error desconocido'); this.h.onError?.(msg); reject(new Error(msg)); };
    });
    this.loading.catch(() => {});
    this.worker.postMessage({ type: 'load', model, proc });
    return this.loading;
  }
  onWorker(m, resolve, reject) {
    if (m.type === 'progress') this.h.onProgress?.(m);
    else if (m.type === 'warming') this.h.onWarming?.(m.device);
    else if (m.type === 'ready') { this.ready = true; this.device = m.device; this.h.onReady?.(m.device); resolve(m.device); this.tick(); }
    else if (m.type === 'result') this.onResult(m);
    else if (m.type === 'error') {
      if (!this.ready) { const msg = explain(m.detail); this.worker?.terminate(); this.worker = null; this.key = ''; this.h.onError?.(msg); reject(new Error(msg)); }
      else { this.busy = false; this.pending = null; console.warn('[Live]', m.detail); }
    }
  }

  /* ---------- Captura ---------- */
  async ensureCtx() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
      this.tap = new AudioWorkletNode(this.ctx, 'wairua-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const mute = this.ctx.createGain(); mute.gain.value = 0;
      this.tap.connect(mute).connect(this.ctx.destination);
      this.tap.port.onmessage = e => this.onAudio(e.data);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }
  reset() {
    this.buf.n = 0; this.total = 0; this.winStart = 0; this.noise = 0.008; this.partial = ''; this.lastFinal = '';
    this.pending = null; this.busy = false; this.resampler = new Resampler(this.ctx.sampleRate);
  }
  async startStream(stream) {
    await this.ensureCtx(); this.reset();
    this.node = this.ctx.createMediaStreamSource(stream);
    this.node.connect(this.tap);
    this.running = true; this.h.onState?.('Escuchando…');
  }
  async startElement(el) {
    await this.ensureCtx(); this.reset();
    let s = elementSources.get(el);
    if (!s) { s = this.ctx.createMediaElementSource(el); s.connect(this.ctx.destination); elementSources.set(el, s); }
    s.connect(this.tap); this.node = s; this.isElement = true;
    this.running = true; this.h.onState?.('Escuchando…');
  }
  stop() {
    if (!this.running) return;
    this.running = false;
    try { this.isElement ? this.node.disconnect(this.tap) : this.node.disconnect(); } catch {}
    this.node = null; this.isElement = false;
    if (this.partial) this.emitFinal(this.partial, this.winStart / SR, this.total / SR);
    this.partial = ''; this.h.onPartial?.('');
    this.h.onState?.('Detenido');
  }
  dispose() { this.stop(); this.worker?.terminate(); this.worker = null; this.key = ''; this.ready = false; }

  onAudio(chunk) {
    if (!this.running) return;
    const x = this.resampler.process(chunk);
    if (!x.length) return;
    this.buf.push(x); this.total += x.length;
    for (let i = 0; i < x.length; i++) { this.recent[this.recentPos] = x[i]; this.recentPos = (this.recentPos + 1) % this.recent.length; }
    const F = Math.round(SR * CFG.frame);
    for (let s = 0; s + F <= x.length; s += F) { const r = rms(x, s, s + F); this.noise = r < this.noise ? this.noise * 0.7 + r * 0.3 : this.noise * 1.003; }
    this.tick();
  }

  /* ---------- Detector de voz ---------- */
  isSpeech(r) { return r > Math.max(0.006, this.noise * 3.2); }
  speechFrames(a) { const F = Math.round(SR * CFG.frame); let n = 0; for (let s = 0; s + F <= a.length; s += F) if (this.isSpeech(rms(a, s, s + F))) n++; return n; }
  tailSilence(a) { const F = Math.round(SR * CFG.frame); let t = 0; for (let e = a.length; e - F >= 0; e -= F) { if (this.isSpeech(rms(a, e - F, e))) break; t += CFG.frame; } return t; }
  quietestCut(a, from, to) { const F = Math.round(SR * CFG.frame); let best = to, br = Infinity; for (let s = Math.max(0, from); s + F <= to; s += F) { const r = rms(a, s, s + F); if (r < br) { br = r; best = s + (F >> 1); } } return best; }

  /* ---------- Planificación ---------- */
  tick() {
    if (!this.ready || this.busy || !this.running) return;
    const dur = this.buf.n / SR;
    if (dur < CFG.minRun) return;
    const a = this.buf.view();
    if (this.speechFrames(a) < 3) {
      if (dur > 2) { this.buf.drop(this.buf.n - Math.round(SR * 0.4)); this.winStart = this.total - this.buf.n; }
      if (this.partial) { this.partial = ''; this.h.onPartial?.(''); }
      this.h.onState?.('Escuchando…');
      return;
    }
    const tail = this.tailSilence(a);
    if (tail >= CFG.tailSilence && dur - tail >= 0.4) this.send(this.buf.n - Math.round(SR * Math.max(0, tail - 0.25)), true);
    else if (dur >= CFG.maxWin) this.send(this.quietestCut(a, this.buf.n - SR * 4, this.buf.n - Math.round(SR * 0.3)), true);
    else this.send(this.buf.n, false);
  }
  send(len, final) {
    this.busy = true; this.runId++;
    const audio = this.buf.view(len).slice();
    this.pending = { id: this.runId, len, final, start: this.winStart, endSample: this.winStart + len };
    this.h.onState?.(final ? 'Cerrando frase…' : 'Transcribiendo…');
    this.worker.postMessage({ type: 'run', id: this.runId, audio, language: this.language }, [audio.buffer]);
  }
  onResult(m) {
    const p = this.pending;
    if (!p || m.id !== p.id) { this.busy = false; return; }
    this.pending = null; this.busy = false;
    this.h.onMetrics?.({ ms: m.ms, lag: Math.max(0, (this.total - p.endSample) / SR) });
    if (!this.running) return;
    if (p.final) {
      if (m.text) this.emitFinal(m.text, p.start / SR, p.endSample / SR);
      this.buf.drop(p.len); this.winStart = p.endSample;
      this.partial = '';
    } else this.partial = m.text;
    this.h.onPartial?.(this.partial);
    setTimeout(() => this.tick(), 0);
  }
  emitFinal(text, start, end) {
    if (text === this.lastFinal) return; // repetición idéntica
    this.lastFinal = text;
    this.h.onFinal?.({ start, end, text });
  }
}

function explain(d) {
  d = String(d || '');
  if (/fetch|network|huggingface/i.test(d)) return 'No se ha podido descargar el modelo. Revisa la conexión o el bloqueador de contenido.';
  if (/memory|allocation|OOM/i.test(d)) return 'Memoria insuficiente. Prueba con el modelo Tiny.';
  return 'Error del motor: ' + d.split('\n')[0];
}

// Motor simulado (?mock): permite probar captura e interfaz sin descargar modelos.
function mockWorker() {
  const W = 'el paciente presenta prurito intenso en la zona dorsolumbar desde hace dos semanas sin vómitos ni diarrea y con apetito conservado'.split(' ');
  const w = { onmessage: null, onerror: null, terminate() {}, postMessage(m) {
    const reply = d => setTimeout(() => w.onmessage?.({ data: d }), d.type === 'result' ? 350 : 120);
    if (m.type === 'load') { reply({ type: 'progress', pct: 100, loaded: 1, total: 1 }); reply({ type: 'ready', device: 'webgpu' }); }
    if (m.type === 'run') { const n = Math.max(1, Math.round(m.audio.length / SR * 2.2)); const off = (m.id * 3) % W.length; reply({ type: 'result', id: m.id, ms: 350, text: Array.from({ length: n }, (_, i) => W[(off + i) % W.length]).join(' ') }); }
  } };
  return w;
}

// Una sola instancia compartida: un único modelo en memoria para la
// sección «En directo» y para la grabadora del transcriptor.
let shared = null;
export function getSharedEngine() {
  return shared || (shared = new LiveEngine({}, { mock: new URLSearchParams(location.search).has('mock') }));
}
