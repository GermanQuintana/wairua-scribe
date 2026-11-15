// Wairua Scribe — interfaz
import { getSharedEngine } from './live-engine.js';
const $ = id => document.getElementById(id);
const $$ = sel => [...document.querySelectorAll(sel)];

// iPhone/iPad (incluido el iPad en modo escritorio) y Android. En iOS todos
// los navegadores (Safari, Chrome, Firefox) usan el motor de Safari y la
// pestaña tiene un límite de memoria estricto: si se supera, iOS la recarga.
const UA = navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
const IS_MOBILE = IS_IOS || /Android/.test(UA);
const TINY = 'onnx-community/whisper-tiny', SMALL = 'onnx-community/whisper-small';

/* Pequeño almacén en IndexedDB: guarda la última grabación para poder
   recuperarla si el navegador recarga la página a mitad de transcripción. */
let dbP = null;
const db = () => dbP ||= new Promise((res, rej) => {
  const r = indexedDB.open('wairua-scribe', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function kv(mode, key, val) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', mode), st = tx.objectStore('kv');
    const rq = mode === 'readonly' ? st.get(key) : val === undefined ? st.delete(key) : st.put(val, key);
    tx.oncomplete = () => res(rq.result); tx.onerror = () => rej(tx.error);
  });
}

/* ============================================================
   Idioma de la interfaz
   ============================================================ */
let lang = localStorage.getItem('scribe-lang') || 'es';
const T = (es, en) => (lang === 'es' ? es : en);

function splitTitle() {
  const h = document.querySelector('.hero-title');
  let i = 0;
  const wrap = node => {
    [...node.childNodes].forEach(n => {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach(part => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.append(part); return; }
          const s = document.createElement('span');
          s.className = 'w'; s.style.setProperty('--i', i++); s.textContent = part;
          frag.append(s);
        });
        n.replaceWith(frag);
      } else if (n.nodeType === 1) wrap(n);
    });
  };
  wrap(h);
}

function applyLang() {
  document.documentElement.lang = lang;
  $$('[data-es]').forEach(el => {
    const v = el.dataset[lang];
    if (v == null) return;
    if (el.tagName === 'OPTION') el.textContent = v; else el.innerHTML = v;
  });
  $$('[data-es-ph]').forEach(el => el.placeholder = el.dataset[lang + 'Ph']);
  $('lang').textContent = lang === 'es' ? 'EN' : 'ES';
  splitTitle();
  if (selectedFile) showFile(selectedFile);
  runDiagnostics();
}
$('lang').addEventListener('click', () => {
  lang = lang === 'es' ? 'en' : 'es';
  localStorage.setItem('scribe-lang', lang);
  applyLang();
});

/* ============================================================
   Ambiente: cabecera, apariciones, luz en tarjetas
   ============================================================ */
const topbar = $('topbar');
addEventListener('scroll', () => topbar.classList.toggle('is-scrolled', scrollY > 40), { passive: true });

const io = new IntersectionObserver(entries => entries.forEach(e => {
  if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }
}), { threshold: 0.12 });
$$('.section-head, .step, .check-card, .browsers, .howto article, .studio-col, .diag, .stat, .science-notes > div, .rules li, .compare-col, .tech-grid > *, .author-card').forEach((el, i) => {
  el.classList.add('in-view'); el.style.transitionDelay = (i % 3) * 0.08 + 's'; io.observe(el);
});
$$('.card').forEach(c => c.addEventListener('pointermove', e => {
  const r = c.getBoundingClientRect();
  c.style.setProperty('--cx', e.clientX - r.left + 'px');
  c.style.setProperty('--cy', e.clientY - r.top + 'px');
}));

/* ============================================================
   Estado y utilidades
   ============================================================ */
let selectedFile = null;
let chunks = [];
let worker = null;
let busy = false;
let timer = null, startedAt = 0;
let wakeLock = null;

const fmtClock = s => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(x).padStart(2, '0');
};
const fmtSrt = s => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, x = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')},${String(r).padStart(3, '0')}`;
};
const fmtMB = b => (b / 1048576).toFixed(b > 104857600 ? 0 : 1) + ' MB';

function setStatus(msg, kind = '') {
  const s = $('status'); s.textContent = msg; s.className = 'status' + (kind ? ' is-' + kind : '');
}

/* ============================================================
   Fuente: archivo (con arrastrar y soltar) o micrófono
   ============================================================ */
$$('.tab').forEach(tab => tab.addEventListener('click', () => {
  $$('.tab').forEach(t => { t.classList.toggle('is-active', t === tab); t.setAttribute('aria-selected', t === tab); });
  $$('.tab-panel').forEach(p => p.hidden = p.dataset.panel !== tab.dataset.tab);
}));

function showFile(f) {
  $('drop').classList.add('has-file');
  $('drop-title').textContent = f.name;
  $('drop-sub').textContent = `${fmtMB(f.size)} · ${T('listo para transcribir', 'ready to transcribe')}`;
}
function selectFile(f) {
  if (!f) return;
  selectedFile = f;
  showFile(f);
  setStatus('');
}
$('file').addEventListener('change', () => selectFile($('file').files[0]));
const drop = $('drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('is-over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('is-over'); }));
drop.addEventListener('drop', e => selectFile(e.dataTransfer.files[0]));

// --- Transcripción en directo mientras se graba ---
const liveEngine = getSharedEngine();
let recLive = false, recPartial = '';
const recHandlers = {
  onPartial: t => { recPartial = t; renderResult(); },
  onFinal: f => { chunks.push(f); renderResult(); },
  onState: () => {},
  onMetrics: () => {},
  onProgress: m => {
    $('progress-wrap').hidden = false;
    setBar(m.pct, m.cached
      ? T('Cargando el modelo guardado en este dispositivo (sigue grabando)…', 'Loading the model saved on this device (still recording)…')
      : m.total ? T(`Descargando modelo (solo la primera vez) · ${fmtMB(m.loaded)} de ${fmtMB(m.total)} (sigue grabando)`, `Downloading model (first time only) · ${fmtMB(m.loaded)} of ${fmtMB(m.total)} (still recording)`) : T('Cargando modelo…', 'Loading model…'));
  },
  onWarming: d => { $('progress-wrap').hidden = false; setBar(null, T('Preparando el motor en directo…', 'Preparing live engine…')); $('device-tag').textContent = d === 'webgpu' ? '⚡ WebGPU' : '◐ CPU · WASM'; },
  onReady: d => {
    $('progress-wrap').hidden = true;
    setStatus(d === 'webgpu' ? T('Transcribiendo en directo mientras grabas.', 'Transcribing live while you record.') : T('Transcribiendo en directo con CPU: el texto irá con retraso.', 'Live transcription on CPU: text will lag behind.'), 'ok');
  },
  onError: msg => { $('progress-wrap').hidden = true; setStatus(msg + ' ' + T('La grabación continúa; podrás transcribirla al terminar.', 'Recording continues; you can transcribe it afterwards.'), 'error'); },
};
async function startRecLive(stream) {
  if (liveEngine.running) { setStatus(T('La sección «En directo» está usando el motor: el texto se mostrará al terminar.', 'The Live section is using the engine: text will appear when you finish.')); return; }
  recLive = true; recPartial = ''; chunks = [];
  $('result').value = ''; $('result').readOnly = true; updateCount();
  liveEngine.h = recHandlers;
  liveEngine.language = $('language').value;
  try {
    await liveEngine.startStream(stream);   // captura desde ya; el modelo se carga en paralelo
    const model = document.querySelector('input[name=model]:checked').value;
    const proc = $('processor').value === 'wasm' ? 'wasm' : (device?.gpuReady ? 'auto' : 'wasm');
    await liveEngine.load({ model, proc });
  } catch (e) { console.warn('[Scribe] directo', e); }
}
function stopRecLive() {
  if (!recLive) return;
  liveEngine.stop();
  recLive = false; recPartial = '';
  $('result').readOnly = false;
  $('progress-wrap').hidden = true;
  renderResult();
}

// --- Grabadora ---
let lastRecording = null;
$('rec-save').addEventListener('click', async () => {
  const f = lastRecording; if (!f) return;
  // En el móvil abre la hoja de compartir (Guardar en Archivos, AirDrop…)
  try { if (IS_MOBILE && navigator.canShare?.({ files: [f] })) { await navigator.share({ files: [f] }); return; } }
  catch (e) { if (e.name === 'AbortError') return; }
  const url = URL.createObjectURL(f);
  const a = Object.assign(document.createElement('a'), { href: url, download: f.name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

let recorder = null, recChunks = [], recStream = null, recStart = 0, recTimer = null, meterRAF = 0, analyser = null, recCtx = null;
const meter = $('meter'), mctx = meter.getContext('2d');

function drawMeter() {
  const w = meter.width, h = meter.height;
  mctx.clearRect(0, 0, w, h);
  const data = new Uint8Array(analyser ? analyser.fftSize : 512);
  if (analyser) analyser.getByteTimeDomainData(data); else data.fill(128);
  mctx.lineWidth = 2;
  const g = mctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(34,193,241,0)'); g.addColorStop(.2, '#22c1f1'); g.addColorStop(.8, '#22c1f1'); g.addColorStop(1, 'rgba(34,193,241,0)');
  mctx.strokeStyle = g; mctx.shadowColor = '#22c1f1'; mctx.shadowBlur = 10;
  mctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * w, y = h / 2 + ((data[i] - 128) / 128) * h * 0.9;
    i ? mctx.lineTo(x, y) : mctx.moveTo(x, y);
  }
  mctx.stroke();
  if (analyser) meterRAF = requestAnimationFrame(drawMeter);
}
drawMeter();

$('rec').addEventListener('click', async () => {
  if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch (e) {
    setStatus(T('No se ha podido acceder al micrófono. Revisa los permisos del navegador.', 'Could not access the microphone. Check browser permissions.'), 'error');
    return;
  }
  recCtx = new AudioContext();
  analyser = recCtx.createAnalyser(); analyser.fftSize = 1024;
  recCtx.createMediaStreamSource(recStream).connect(analyser);
  drawMeter();
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
  recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  recChunks = [];
  recorder.ondataavailable = e => e.data.size && recChunks.push(e.data);
  recorder.onstop = () => {
    const hadLive = recLive;
    $('start').disabled = busy;
    stopRecLive();
    clearInterval(recTimer); cancelAnimationFrame(meterRAF);
    recStream.getTracks().forEach(t => t.stop()); recCtx.close(); analyser = null; drawMeter();
    $('rec').setAttribute('aria-pressed', 'false');
    const type = recorder.mimeType || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    const file = new File(recChunks, `grabacion_${stamp}.${ext}`, { type });
    selectFile(file);
    lastRecording = file;
    $('rec-save').hidden = false;
    kv('readwrite', 'last-recording', { blob: file, name: file.name, type }).catch(() => {});
    $('rec-label').textContent = T('Grabación lista. Pulsa «Transcribir».', 'Recording ready. Press “Transcribe”.');
    if (hadLive && chunks.length) setStatus(T('Texto en directo listo. Si quieres una versión más precisa, pulsa «Transcribir»: hará una segunda pasada completa y sustituirá este texto.', 'Live text ready. For a more accurate version press “Transcribe”: it runs a full second pass and replaces this text.'), 'ok');
    else if (hadLive) setStatus(T('El modelo no llegó a cargarse a tiempo. Pulsa «Transcribir» para transcribir la grabación.', 'The model did not load in time. Press “Transcribe” to transcribe the recording.'));
  };
  recorder.start(1000);
  if ($('rec-live').checked) startRecLive(recStream);
  $('start').disabled = true; // no se puede transcribir un archivo mientras se graba
  recStart = Date.now();
  $('rec').setAttribute('aria-pressed', 'true');
  $('rec-label').textContent = T('Grabando… pulsa para detener', 'Recording… press to stop');
  recTimer = setInterval(() => $('rec-time').textContent = fmtClock((Date.now() - recStart) / 1000), 250);
});

/* ============================================================
   Decodificación del audio a 16 kHz mono
   ============================================================ */
async function decodeTo16k(file) {
  const buf = await file.arrayBuffer();
  let decoded;
  try {
    const ctx = new AudioContext({ sampleRate: 16000 });
    try { decoded = await ctx.decodeAudioData(buf.slice(0)); } finally { ctx.close(); }
  } catch (e) {
    // Plan B: decodificar a la frecuencia nativa y remuestrear
    const ctx = new AudioContext();
    try { decoded = await ctx.decodeAudioData(buf); } finally { ctx.close(); }
  }
  if (!decoded) throw new Error('DECODE');
  if (decoded.duration > 2 * 3600) throw new Error('TOO_LONG');

  if (decoded.sampleRate === 16000) {
    if (decoded.numberOfChannels === 1) return decoded.getChannelData(0);
    const a = decoded.getChannelData(0), b = decoded.getChannelData(1), out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) * 0.5;
    return out;
  }
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  return (await off.startRendering()).getChannelData(0);
}

/* ============================================================
   Transcripción
   ============================================================ */
const STAGES = {
  decode: () => T('Preparando el audio…', 'Preparing audio…'),
  load: d => T(`Cargando el modelo (${d === 'webgpu' ? 'GPU' : 'CPU'})…`, `Loading model (${d === 'webgpu' ? 'GPU' : 'CPU'})…`),
  transcribe: () => T('Transcribiendo…', 'Transcribing…'),
};
const ERRORS = {
  NET_LIB: () => T('No se ha podido descargar el motor de transcripción. Comprueba la conexión y que ningún bloqueador impida el acceso a cdn.jsdelivr.net.', 'Could not download the transcription engine. Check your connection and that nothing blocks cdn.jsdelivr.net.'),
  NO_GPU: () => T('Este navegador no ofrece una GPU compatible con WebGPU. Elige «Automático» o «Solo CPU».', 'This browser has no WebGPU-compatible GPU. Choose “Automatic” or “CPU only”.'),
  DECODE: () => T('El navegador no puede leer este formato. Prueba con MP3, M4A o WAV.', 'The browser cannot read this format. Try MP3, M4A or WAV.'),
  TOO_LONG: () => T('El archivo supera las 2 horas permitidas en esta beta. Divídelo en partes.', 'The file exceeds the 2-hour beta limit. Split it into parts.'),
};
function explain(code, detail = '') {
  if (ERRORS[code]) return ERRORS[code]();
  const d = String(detail);
  if (/fetch|network|Failed to fetch|load model|huggingface|404/i.test(d))
    return T('No se ha podido descargar el modelo desde Hugging Face. Revisa la conexión, el cortafuegos o el bloqueador de contenido.', 'Could not download the model from Hugging Face. Check your connection, firewall or content blocker.');
  if (/memory|OOM|allocation|RangeError|Array buffer/i.test(d))
    return T('El equipo se ha quedado sin memoria. Usa el modelo Tiny o Base, cierra pestañas o divide el audio.', 'The device ran out of memory. Use the Tiny or Base model, close tabs or split the audio.');
  return T('No se ha podido transcribir: ', 'Transcription failed: ') + (d.split('\n')[0] || code) + T(' — Prueba con «Solo CPU» y el modelo Tiny.', ' — Try “CPU only” and the Tiny model.');
}

function setBusy(on) {
  busy = on;
  $('start').disabled = on;
  $('cancel').hidden = !on;
  $('progress-wrap').hidden = !on;
  $('rec').disabled = on;
  if (on) {
    startedAt = Date.now();
    timer = setInterval(() => $('elapsed').textContent = fmtClock((Date.now() - startedAt) / 1000), 500);
    navigator.wakeLock?.request('screen').then(l => wakeLock = l).catch(() => {});
  } else {
    try { localStorage.removeItem('scribe-running'); } catch {}
    clearInterval(timer);
    wakeLock?.release().catch(() => {}); wakeLock = null;
  }
}
function setBar(pct, label) {
  const bar = $('bar').parentElement;
  if (pct == null) { bar.classList.add('indeterminate'); $('pct').textContent = ''; }
  else { bar.classList.remove('indeterminate'); $('bar').style.width = pct + '%'; $('pct').textContent = Math.round(pct) + '%'; }
  if (label) $('stage').textContent = label;
}

function renderResult() {
  const withTs = $('timestamps').checked;
  let v = withTs
    ? chunks.map(c => `[${fmtClock(c.start)}] ${c.text}`).join('\n')
    : joinText(chunks);
  if (recLive && recPartial) v += (v ? (withTs ? '\n' : ' ') : '') + recPartial + ' …';
  $('result').value = v;
  updateCount();
  $('result').scrollTop = $('result').scrollHeight;
}
function joinText(cs) {
  return cs.map(c => c.text).join(' ').replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}
function updateCount() {
  const n = ($('result').value.match(/\S+/g) || []).length;
  $('wordcount').textContent = n ? `${n} ${T('palabras', 'words')}` : '';
}
$('result').addEventListener('input', updateCount);
$('timestamps').addEventListener('change', () => { if (chunks.length) renderResult(); });

function newWorker() {
  worker?.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onerror = e => {
    console.error('[Scribe] Worker', e);
    finishWithError('WORKER', e.message || T('El motor se ha detenido inesperadamente.', 'The engine stopped unexpectedly.'));
  };
  worker.onmessage = ({ data: m }) => {
    switch (m.type) {
      case 'stage':
        $('device-tag').textContent = m.device === 'webgpu' ? '⚡ WebGPU' : '◐ CPU · WASM';
        if (m.stage === 'load') setBar(null, m.cached ? T(`Cargando el modelo guardado en este dispositivo (${m.device === 'webgpu' ? 'GPU' : 'CPU'})…`, `Loading the model saved on this device (${m.device === 'webgpu' ? 'GPU' : 'CPU'})…`) : STAGES.load(m.device));
        if (m.stage === 'transcribe') setBar(0, STAGES.transcribe());
        break;
      case 'load-progress':
        if (m.total) setBar(m.progress, m.cached
          ? T('Cargando el modelo guardado en este dispositivo…', 'Loading the model saved on this device…')
          : T(`Descargando modelo (solo la primera vez) · ${fmtMB(m.loaded)} de ${fmtMB(m.total)}`, `Downloading model (first time only) · ${fmtMB(m.loaded)} of ${fmtMB(m.total)}`));
        break;
      case 'notice':
        setStatus({
          'gpu-fallback': T('No hay GPU compatible: se usará la CPU (más lento).', 'No compatible GPU: using CPU (slower).'),
          'gpu-load-failed': T('La GPU no ha podido cargar el modelo: se continúa con CPU.', 'GPU could not load the model: continuing on CPU.'),
          'gpu-run-failed': T('La GPU ha fallado durante la transcripción: se reintenta con CPU.', 'GPU failed during transcription: retrying on CPU.'),
        }[m.code] || '');
        break;
      case 'progress':
        chunks.push(...m.chunks);
        renderResult();
        setBar((m.position / m.duration) * 100, T(`Transcribiendo · ${fmtClock(m.position)} de ${fmtClock(m.duration)}`, `Transcribing · ${fmtClock(m.position)} of ${fmtClock(m.duration)}`));
        break;
      case 'done': {
        chunks = m.chunks; renderResult();
        setBusy(false);
        const speed = m.duration / Math.max(1, m.seconds);
        setStatus(chunks.length
          ? T(`Listo: ${fmtClock(m.duration)} de audio en ${fmtClock(m.seconds)} (${speed.toFixed(1)}× tiempo real, ${m.device === 'webgpu' ? 'GPU' : 'CPU'}). Revisa nombres, dosis y negaciones.`,
              `Done: ${fmtClock(m.duration)} of audio in ${fmtClock(m.seconds)} (${speed.toFixed(1)}× real time, ${m.device === 'webgpu' ? 'GPU' : 'CPU'}). Check names, doses and negations.`)
          : T('No se ha detectado voz en el audio.', 'No speech was detected in the audio.'), chunks.length ? 'ok' : '');
        if (document.hidden) document.title = '✓ ' + T('Transcripción lista', 'Transcript ready');
        navigator.storage?.persist?.().catch(() => {});
        updateCacheMarks();
        break;
      }
      case 'error':
        finishWithError(m.code, m.detail);
        break;
    }
  };
}
function finishWithError(code, detail) {
  setBusy(false);
  setStatus(explain(code, detail), 'error');
  worker?.terminate(); worker = null;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Wairua Scribe · Transcripción local para veterinaria'; });

$('start').addEventListener('click', async () => {
  if (busy) return;
  if (location.protocol === 'file:') { setStatus(T('Abre la app con http://localhost:8000 (ver README), no con doble clic.', 'Open the app via http://localhost:8000 (see README), not by double-clicking.'), 'error'); return; }
  if (!window.isSecureContext) { setStatus(T('Se necesita HTTPS o localhost para transcribir.', 'HTTPS or localhost is required.'), 'error'); return; }
  if (!selectedFile) { setStatus(T('Elige un archivo o graba un audio primero.', 'Choose a file or record audio first.'), 'error'); return; }

  // En móvil (o con Small) se libera el motor en directo para no tener dos
  // modelos en memoria. En ordenador se conserva: así la siguiente grabación
  // no tiene que volver a cargarlo.
  const modelSel = document.querySelector('input[name=model]:checked').value;
  if (!liveEngine.running && (IS_MOBILE || modelSel === SMALL)) liveEngine.dispose();
  chunks = []; $('result').value = ''; updateCount();
  setBusy(true);
  setStatus('');
  setBar(null, STAGES.decode());
  $('device-tag').textContent = '';

  let audio;
  try {
    audio = await decodeTo16k(selectedFile);
  } catch (e) {
    console.error(e);
    finishWithError(e.message === 'TOO_LONG' ? 'TOO_LONG' : 'DECODE', e.message);
    return;
  }
  if (audio.length / 16000 > 3600) setStatus(T('Audio largo: puede tardar bastante. Mantén esta pestaña abierta.', 'Long audio: this may take a while. Keep this tab open.'));

  if (!worker) newWorker();
  const model = modelSel;
  const processor = ($('processor').value === 'auto' && device && !device.gpuReady) ? 'wasm' : $('processor').value;
  try {
    localStorage.setItem('scribe-running', JSON.stringify({
      model, gpu: processor !== 'wasm' && !!device?.gpuReady, rec: !!lastRecording && selectedFile === lastRecording, t: Date.now(),
    }));
  } catch {}
  // en móvil se transfiere el buffer original (sin copia) para ahorrar memoria
  const copy = IS_MOBILE ? audio : new Float32Array(audio);
  audio = null;
  worker.postMessage({ type: 'transcribe', audio: copy, model, language: $('language').value, processor }, [copy.buffer]);
});

$('cancel').addEventListener('click', () => {
  worker?.terminate(); worker = null;
  setBusy(false);
  setStatus(T('Transcripción cancelada. Se conserva el texto obtenido hasta ahora.', 'Transcription cancelled. Text so far has been kept.'));
});

/* ============================================================
   Exportar
   ============================================================ */
function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
const baseName = () => (selectedFile?.name || 'transcripcion').replace(/\.[^.]+$/, '');
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('result').value); setStatus(T('Texto copiado.', 'Text copied.'), 'ok'); }
  catch { $('result').select(); setStatus(T('Selecciona y copia con Ctrl/Cmd+C.', 'Select and copy with Ctrl/Cmd+C.')); }
});
$('dl-txt').addEventListener('click', () => {
  if (!$('result').value.trim()) return setStatus(T('Aún no hay texto que descargar.', 'No text to download yet.'));
  download(`${baseName()}_wairua.txt`, $('result').value);
});
$('dl-srt').addEventListener('click', () => {
  if (!chunks.length) return setStatus(T('El SRT necesita una transcripción con marcas de tiempo.', 'SRT needs a timestamped transcript.'));
  const srt = chunks.map((c, i) => `${i + 1}\n${fmtSrt(c.start)} --> ${fmtSrt(Math.max(c.end, c.start + 0.5))}\n${c.text}\n`).join('\n');
  download(`${baseName()}_wairua.srt`, srt, 'application/x-subrip');
});

/* ============================================================
   Compatibilidad del dispositivo (navegador + GPU)
   ============================================================ */
let device = null; // resultado de la última comprobación

function detectBrowser() {
  const ua = navigator.userAgent;
  const brands = navigator.userAgentData?.brands || [];
  const brand = n => brands.find(x => x.brand === n);
  let name = T('Desconocido', 'Unknown'), ver = '';
  if (/FxiOS\/(\d+)/.test(ua)) { name = 'Firefox'; ver = RegExp.$1; }
  else if (/CriOS\/(\d+)/.test(ua)) { name = 'Chrome'; ver = RegExp.$1; }
  else if (/EdgiOS\/(\d+)/.test(ua)) { name = 'Edge'; ver = RegExp.$1; }
  else if (brand('Microsoft Edge')) { name = 'Edge'; ver = brand('Microsoft Edge').version; }
  else if (brand('Opera')) { name = 'Opera'; ver = brand('Opera').version; }
  else if (brand('Brave')) { name = 'Brave'; ver = brand('Brave').version; }
  else if (brand('Google Chrome')) { name = 'Chrome'; ver = brand('Google Chrome').version; }
  else if (/Edg\/(\d+)/.test(ua)) { name = 'Edge'; ver = RegExp.$1; }
  else if (/Firefox\/(\d+)/.test(ua)) { name = 'Firefox'; ver = RegExp.$1; }
  else if (/Chrome\/(\d+)/.test(ua)) { name = 'Chrome'; ver = RegExp.$1; }
  else if (/Version\/(\d+(?:\.\d+)?).*Safari/.test(ua)) { name = 'Safari'; ver = RegExp.$1; }
  const os = /Android/.test(ua) ? 'Android' : IS_IOS ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const chromium = brands.some(x => /Chromium|Chrome|Edge/.test(x.brand)) || /Chrome\//.test(ua);
  return { name, ver, os, chromium: chromium && !IS_IOS, mobile: IS_MOBILE };
}

async function detectGPU() {
  if (!navigator.gpu) return { api: false };
  try {
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return { api: true, adapter: false };
    const info = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : {}) || {};
    const fallback = !!(info.isFallbackAdapter ?? a.isFallbackAdapter);
    const label = [info.vendor, info.architecture].filter(Boolean).join(' ') || info.description || T('GPU detectada', 'GPU detected');
    return { api: true, adapter: true, fallback, label };
  } catch (e) { return { api: true, adapter: false, error: e.message }; }
}

async function checkDevice() {
  const br = detectBrowser();
  const gpu = await detectGPU();
  let state, title, text, mode, badge;
  const bname = `${br.name}${br.ver ? ' ' + br.ver : ''}${br.os ? ' · ' + br.os : ''}`;
  if (location.protocol === 'file:') {
    state = 'bad'; title = T('Abierta como archivo', 'Opened as a file');
    text = T('Así no puede transcribir. Arráncala con el servidor local y entra por http://localhost:8000.', 'It cannot transcribe like this. Start the local server and open http://localhost:8000.');
    mode = '—'; badge = T('Abre la app con http://localhost:8000', 'Open the app via http://localhost:8000');
  } else if (!window.isSecureContext) {
    state = 'bad'; title = T('Conexión no segura', 'Insecure connection');
    text = T('Se necesita HTTPS (o localhost) para usar la GPU y el micrófono.', 'HTTPS (or localhost) is required for the GPU and microphone.');
    mode = '—'; badge = T('Se necesita HTTPS', 'HTTPS required');
  } else if (gpu.adapter && !gpu.fallback) {
    state = 'ok'; title = T('Listo para GPU', 'GPU ready');
    text = IS_MOBILE
      ? T('WebGPU está activo. Usa «Automático» con Tiny o Base; Small queda reservado al ordenador por memoria.', 'WebGPU is active. Use “Automatic” with Tiny or Base; Small is reserved for computers because of memory.')
      : T('WebGPU está activo. Usa «Automático»; los modelos Base y Small irán con fluidez.', 'WebGPU is active. Use “Automatic”; Base and Small models will run smoothly.');
    mode = T('Automático · GPU', 'Automatic · GPU'); badge = `${bname} · ${T('GPU lista', 'GPU ready')}`;
  } else if (gpu.adapter && gpu.fallback) {
    state = 'warn'; title = T('GPU solo por software', 'Software-only GPU');
    text = T('El navegador emula la GPU y no acelera nada. Activa la aceleración (paso A) o actualiza el controlador (paso B). Mientras, usa «Solo CPU».', 'The browser is emulating the GPU, which gives no speed-up. Turn on acceleration (step A) or update your driver (step B). Meanwhile use “CPU only”.');
    mode = T('Solo CPU', 'CPU only'); badge = `${bname} · ${T('GPU emulada: se usará CPU', 'emulated GPU: CPU will be used')}`;
  } else {
    state = 'warn'; mode = T('Solo CPU (Tiny o Base)', 'CPU only (Tiny or Base)');
    badge = `${bname} · ${T('sin GPU: se usará CPU', 'no GPU: CPU will be used')}`;
    if (br.chromium && gpu.api) {
      title = T('Activa la aceleración', 'Turn on acceleration');
      text = T('Tu navegador admite WebGPU pero no encuentra una GPU utilizable. Sigue los pasos A, B y C de abajo y vuelve a comprobar.', 'Your browser supports WebGPU but found no usable GPU. Follow steps A, B and C below and check again.');
    } else if (br.chromium) {
      title = T('Navegador sin WebGPU', 'Browser without WebGPU');
      text = T('Actualiza Chrome o Edge a la última versión y activa la aceleración (paso A).', 'Update Chrome or Edge to the latest version and turn on acceleration (step A).');
    } else if (br.name === 'Firefox') {
      title = T('Firefox sin WebGPU aquí', 'No WebGPU in Firefox here');
      text = T('En este sistema Firefox aún no ofrece WebGPU. Para usar la GPU abre la app en Chrome o Edge; si no, funcionará con la CPU.', 'Firefox does not offer WebGPU on this system yet. Open the app in Chrome or Edge for GPU; otherwise it will run on CPU.');
    } else if (br.name === 'Safari') {
      title = T('Actualiza Safari', 'Update Safari');
      text = T('WebGPU llega con Safari 26 (macOS Tahoe, iOS 26). Con versiones anteriores funcionará con la CPU.', 'WebGPU arrives with Safari 26 (macOS Tahoe, iOS 26). Older versions will use the CPU.');
    } else {
      title = T('Sin aceleración GPU', 'No GPU acceleration');
      text = T('Para usar la GPU, abre la app en Chrome o Edge actualizados. Mientras, funcionará con la CPU.', 'For GPU, open the app in an up-to-date Chrome or Edge. Meanwhile it will run on CPU.');
    }
  }
  device = { br, gpu, state, gpuReady: !!(gpu.adapter && !gpu.fallback) };

  const card = $('check-card');
  card.dataset.state = state;
  $('check-title').textContent = title;
  $('check-text').textContent = text;
  $('cf-browser').textContent = bname;
  $('cf-gpu').textContent = !gpu.api ? T('No disponible', 'Not available') : gpu.adapter ? (gpu.fallback ? T('Solo software', 'Software only') : T('Activo', 'Active')) : T('Sin adaptador', 'No adapter');
  $('cf-adapter').textContent = gpu.label || '—';
  $('cf-mode').textContent = mode;
  const b = $('device-badge');
  b.dataset.state = state;
  $('device-badge-text').textContent = badge;
  renderDiagnostics();
  updateCacheMarks();
}
$('check-again').addEventListener('click', checkDevice);
$('device-badge').addEventListener('click', () => $('req').scrollIntoView({ behavior: 'smooth' }));

/* ============================================================
   Modelos ya descargados en este navegador
   ============================================================ */
const MODEL_FILES = {
  webgpu: ['encoder_model.onnx', 'decoder_model_merged_q4.onnx'],
  wasm: ['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx'],
};
$$('input[name=model]').forEach(inp => {
  const i = document.createElement('i'); i.className = 'cache-mark'; inp.nextElementSibling.append(i);
});
async function updateCacheMarks() {
  let urls = [];
  try { if (window.caches) urls = (await (await caches.open('transformers-cache')).keys()).map(r => r.url); } catch {}
  const proc = $('processor').value;
  const dev = proc === 'wasm' ? 'wasm' : (device?.gpuReady ? 'webgpu' : 'wasm');
  $$('input[name=model]').forEach(inp => {
    const m = inp.value;
    const have = MODEL_FILES[dev].every(f => urls.some(u => u.includes('/' + m + '/') && u.endsWith('/onnx/' + f)));
    inp.nextElementSibling.querySelector('.cache-mark').textContent = have ? T('✓ ya descargado', '✓ already downloaded') : '';
  });
}
$('processor').addEventListener('change', updateCacheMarks);

/* ============================================================
   Diagnóstico
   ============================================================ */
async function renderDiagnostics() {
  const items = [];
  const add = (cls, label, value) => items.push(`<li><span class="${cls}">●</span><span><b>${label}:</b> ${value}</span></li>`);
  add(location.protocol === 'file:' ? 'bad' : window.isSecureContext ? 'ok' : 'bad', T('Origen', 'Origin'),
    location.protocol === 'file:' ? T('archivo local (no funcionará)', 'local file (will not work)') : window.isSecureContext ? T('seguro', 'secure') : T('no seguro: usa HTTPS', 'insecure: use HTTPS'));
  add(window.Worker ? 'ok' : 'bad', 'Web Workers', window.Worker ? T('disponibles', 'available') : T('no disponibles', 'unavailable'));
  if (device) add(device.gpuReady ? 'ok' : 'warn', 'WebGPU', device.gpuReady ? (device.gpu.label || T('activo', 'active')) : T('no disponible: se usará CPU', 'unavailable: CPU will be used'));
  add('ok', T('Núcleos de CPU', 'CPU cores'), navigator.hardwareConcurrency || '?');
  if (navigator.deviceMemory) add(navigator.deviceMemory < 4 ? 'warn' : 'ok', T('Memoria (aprox.)', 'Memory (approx.)'), `≥ ${navigator.deviceMemory} GB`);
  try {
    const est = await navigator.storage?.estimate();
    if (est) add('ok', T('Caché usada', 'Cache used'), fmtMB(est.usage || 0));
    const persisted = await navigator.storage?.persisted?.();
    if (persisted != null) add(persisted ? 'ok' : 'warn', T('Almacenamiento', 'Storage'), persisted ? T('persistente (no se borra solo)', 'persistent (not auto-cleared)') : T('normal (Chrome podría liberarlo si falta espacio)', 'best-effort (may be cleared if disk is full)'));
  } catch {}
  $('diag-list').innerHTML = items.join('');
}
const runDiagnostics = checkDevice;
$('diag-run').addEventListener('click', checkDevice);
$('clear-cache').addEventListener('click', async () => {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.includes('transformers')).map(k => caches.delete(k)));
    setStatus(T('Modelos descargados eliminados de la caché.', 'Downloaded models removed from cache.'), 'ok');
    renderDiagnostics(); updateCacheMarks();
  } catch { setStatus(T('No se ha podido limpiar la caché.', 'Could not clear the cache.'), 'error'); }
});

/* ============================================================
   Textos legales y aviso de cookies
   ============================================================ */
document.addEventListener('click', e => {
  const opener = e.target.closest('[data-dialog]');
  if (opener) { $(opener.dataset.dialog)?.showModal(); return; }
  if (e.target.closest('.dlg-close')) e.target.closest('dialog').close();
  else if (e.target.tagName === 'DIALOG') e.target.close(); // clic en el fondo
});
try {
  if (!localStorage.getItem('scribe-cookies-ok')) $('cookie-bar').hidden = false;
} catch { $('cookie-bar').hidden = false; }
$('cookie-ok').addEventListener('click', () => {
  try { localStorage.setItem('scribe-cookies-ok', '1'); } catch {}
  $('cookie-bar').hidden = true;
});

/* ============================================================
   Perfil móvil, preferencias y recuperación tras un cierre
   ============================================================ */
function setModel(v) { const r = document.querySelector(`input[name=model][value="${v}"]`); if (r && !r.disabled) r.checked = true; }
if (IS_MOBILE) {
  const small = document.querySelector(`input[name=model][value="${SMALL}"]`);
  small.disabled = true;
  if (small.checked) setModel('onnx-community/whisper-base');
  const sm = small.nextElementSibling.querySelector('small');
  sm.dataset.es = 'Solo en ordenador'; sm.dataset.en = 'Computer only';
  $('rec-live').checked = false; // dos modelos a la vez agotan la memoria del móvil
  $('file-hint').hidden = false;
  const dt = $('drop-title'), ds = $('drop-sub');
  dt.dataset.es = 'Toca para elegir tu audio o vídeo'; dt.dataset.en = 'Tap to choose your audio or video';
  ds.dataset.es = 'MP3, M4A, WAV, OGG, WEBM, MP4…'; ds.dataset.en = 'MP3, M4A, WAV, OGG, WEBM, MP4…';
}
try {
  const pm = localStorage.getItem('scribe-model'), pp = localStorage.getItem('scribe-proc');
  if (pm) setModel(pm);
  if (pp && [...$('processor').options].some(o => o.value === pp)) $('processor').value = pp;
} catch {}
$$('input[name=model]').forEach(r => r.addEventListener('change', () => { try { localStorage.setItem('scribe-model', r.value); } catch {} }));
$('processor').addEventListener('change', () => { try { localStorage.setItem('scribe-proc', $('processor').value); } catch {} });

async function recoverFromCrash() {
  let run = null;
  try { run = JSON.parse(localStorage.getItem('scribe-running') || 'null'); localStorage.removeItem('scribe-running'); } catch {}
  if (!run || Date.now() - run.t > 3 * 3600e3) return;
  // La página se recargó en plena transcripción: casi siempre, falta de memoria.
  // Se baja un escalón y se recuerda para la próxima vez.
  let change;
  if (run.gpu) {
    $('processor').value = 'wasm';
    change = T('He cambiado a «Solo CPU», que usa menos memoria (irá más despacio).', 'I switched to “CPU only”, which uses less memory (it will be slower).');
  } else if (run.model !== TINY) {
    setModel(TINY);
    change = T('He cambiado al modelo Tiny, el más ligero.', 'I switched to the Tiny model, the lightest one.');
  } else change = T('Prueba con un audio más corto o divídelo en partes.', 'Try a shorter audio or split it into parts.');
  try { localStorage.setItem('scribe-proc', $('processor').value); localStorage.setItem('scribe-model', document.querySelector('input[name=model]:checked').value); } catch {}
  updateCacheMarks();
  let msg = T('El navegador se quedó sin memoria y recargó la página. ', 'The browser ran out of memory and reloaded the page. ') + change;
  if (run.rec) {
    try {
      const r = await kv('readonly', 'last-recording');
      if (r?.blob) {
        lastRecording = new File([r.blob], r.name, { type: r.type });
        $$('.tab').find(t => t.dataset.tab === 'file')?.click();
        selectFile(lastRecording);
        $('rec-save').hidden = false;
        msg += T(' Tu grabación se ha recuperado: pulsa «Transcribir».', ' Your recording was recovered: press “Transcribe”.');
      }
    } catch {}
  }
  setStatus(msg, 'error');
  setTimeout(() => $('start').scrollIntoView({ behavior: 'smooth', block: 'center' }), 400);
}

applyLang();
recoverFromCrash();
