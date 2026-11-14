// Wairua Scribe — sección «En directo» (subtítulos en tiempo real)
import { getSharedEngine, SR } from './live-engine.js';

const $ = id => document.getElementById(id);
const $$ = s => [...document.querySelectorAll(s)];
const T = (es, en) => (document.documentElement.lang === 'en' ? en : es);
const engine = getSharedEngine();

let src = 'tab', running = false, starting = false, stream = null, offset = 0, partial = '', wake = null;
const finals = [];

const fmt = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(x).padStart(2, '0'); };
const fmtSrt = s => { const ms = Math.round(s * 1000); const p = (n, l = 2) => String(n).padStart(l, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
const fmtMB = b => (b / 1048576).toFixed(0) + ' MB';
function setStatus(t, k = '') { const s = $('lv-status'); s.textContent = t; s.className = 'status' + (k ? ' is-' + k : ''); }

/* ---------- Fuente ---------- */
$$('.src-card').forEach(c => c.addEventListener('click', () => {
  if (running || starting) return;
  src = c.dataset.src;
  $$('.src-card').forEach(b => { b.classList.toggle('is-active', b === c); b.setAttribute('aria-checked', b === c); });
  $$('#live .src-help').forEach(h => h.hidden = h.dataset.help !== src);
  const v = $('lv-video');
  v.hidden = src !== 'video' || !v.src;
  $('lv-stage').classList.toggle('has-video', src === 'video' && !!v.src);
}));
$('lv-vfile').addEventListener('change', () => {
  const f = $('lv-vfile').files[0]; if (!f) return;
  const v = $('lv-video');
  if (v.src) URL.revokeObjectURL(v.src);
  v.src = URL.createObjectURL(f); v.hidden = false;
  $('lv-stage').classList.add('has-video');
  $('lv-vdrop-title').textContent = f.name;
  $('lv-vdrop-sub').textContent = T('Listo · pulsa «Empezar»', 'Ready · press “Start”');
  $('lv-vdrop').classList.add('has-file');
});

/* ---------- Manejadores del motor ---------- */
const handlers = {
  onPartial: t => { partial = t; render(); },
  onFinal: f => addFinal(f),
  onState: t => { $('m-state').textContent = t; },
  onMetrics: ({ ms, lag }) => { $('m-proc').textContent = Math.round(ms) + ' ms'; $('m-lag').textContent = lag.toFixed(1) + ' s'; },
  onProgress: m => {
    $('lv-prog').hidden = false; $('lv-bar').parentElement.classList.remove('indeterminate');
    $('lv-bar').style.width = m.pct + '%'; $('lv-pct').textContent = Math.round(m.pct) + '%';
    $('lv-stage-label').textContent = m.total ? T(`Descargando modelo · ${fmtMB(m.loaded)} de ${fmtMB(m.total)}`, `Downloading model · ${fmtMB(m.loaded)} of ${fmtMB(m.total)}`) : T('Cargando modelo…', 'Loading model…');
  },
  onWarming: d => {
    $('lv-prog').hidden = false; $('lv-pct').textContent = '';
    $('lv-stage-label').textContent = T(`Preparando ${d === 'webgpu' ? 'la GPU' : 'la CPU'}…`, `Preparing ${d === 'webgpu' ? 'GPU' : 'CPU'}…`);
    $('lv-bar').parentElement.classList.add('indeterminate');
  },
  onReady: d => {
    $('lv-prog').hidden = true; $('lv-bar').parentElement.classList.remove('indeterminate');
    $('m-dev').textContent = d === 'webgpu' ? '⚡ GPU' : '◐ CPU';
    if (d !== 'webgpu') setStatus(T('Funcionando con CPU: más retraso. Usa el modelo Tiny.', 'Running on CPU: more delay. Use the Tiny model.'));
  },
  onError: msg => { $('lv-prog').hidden = true; if (running) stop(); setStatus(msg, 'error'); },
};

/* ---------- Subtítulos y registro ---------- */
function addFinal({ start, end, text }) {
  start += offset; end += offset;
  finals.push({ start, end, text });
  const log = $('lv-log');
  log.querySelector('.log-empty')?.remove();
  const p = document.createElement('p'); p.className = 'fresh';
  p.innerHTML = '<time></time><span></span>'; p.firstChild.textContent = fmt(start); p.lastChild.textContent = text;
  log.append(p); log.scrollTop = log.scrollHeight;
  const words = finals.reduce((n, f) => n + f.text.split(/\s+/).length, 0);
  $('lv-count').textContent = T(`${finals.length} frases · ${words} palabras`, `${finals.length} sentences · ${words} words`);
  render();
}
function render() {
  const stage = $('lv-stage');
  const size = parseFloat(getComputedStyle(stage).getPropertyValue('--cap')) || 32;
  const maxChars = Math.max(40, Math.floor(1.85 * (stage.clientWidth * 0.8) / (size * 0.6)));
  let fin = running && finals.length ? finals[finals.length - 1].text : '';
  let live = partial;
  if (live.length > maxChars) { live = '…' + live.slice(-maxChars); fin = ''; }
  else if (fin.length + live.length > maxChars) fin = '…' + fin.slice(-(maxChars - live.length));
  $('lv-cap-final').textContent = fin;
  $('lv-cap-live').textContent = live;
  $('lv-captions').classList.toggle('is-empty', !fin && !live);
}

/* ---------- Osciloscopio (trazo tipo ECG) ---------- */
const scope = $('lv-scope'), sctx = scope.getContext('2d');
function drawScope() {
  if (running && src !== 'video') {
    const dpr = Math.min(devicePixelRatio || 1, 2), w = scope.clientWidth, h = scope.clientHeight;
    if (scope.width !== Math.round(w * dpr)) { scope.width = Math.round(w * dpr); scope.height = Math.round(h * dpr); }
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0); sctx.clearRect(0, 0, w, h);
    const rec = engine.recent, pos = engine.recentPos, N = 600, step = rec.length / N, mid = h * 0.42;
    sctx.globalCompositeOperation = 'lighter';
    for (const [lw, al] of [[7, .1], [1.6, .9]]) {
      sctx.beginPath();
      for (let i = 0; i < N; i++) {
        let peak = 0; const s0 = Math.floor((pos + i * step) % rec.length);
        for (let j = 0; j < step; j += 4) peak = Math.max(peak, Math.abs(rec[(s0 + j) % rec.length]));
        const x = i / (N - 1) * w, y = mid + Math.sin(i * 0.9) * Math.min(1, peak * 4) * h * 0.22;
        i ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
      }
      const g = sctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, 'rgba(34,193,241,0)'); g.addColorStop(.25, `rgba(34,193,241,${al})`); g.addColorStop(.75, `rgba(120,220,255,${al})`); g.addColorStop(1, 'rgba(34,193,241,0)');
      sctx.strokeStyle = g; sctx.lineWidth = lw; sctx.stroke();
    }
    sctx.globalCompositeOperation = 'source-over';
    requestAnimationFrame(drawScope);
  } else sctx.clearRect(0, 0, scope.width, scope.height);
}

/* ---------- Inicio / parada ---------- */
const lmodel = () => document.querySelector('input[name=lmodel]:checked').value;
let gpuReady = false;
const lproc = () => ($('lv-proc').value === 'auto' && !gpuReady) ? 'wasm' : $('lv-proc').value;

async function openSource() {
  if (src === 'tab') {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error(T('Este navegador no permite capturar el audio de otra pestaña. Usa Chrome o Edge en un ordenador.', 'This browser cannot capture another tab’s audio. Use desktop Chrome or Edge.'));
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
    });
    const at = stream.getAudioTracks();
    if (!at.length) { stream.getTracks().forEach(t => t.stop()); stream = null; throw new Error(T('No se ha compartido audio. Vuelve a empezar y activa «Compartir también el audio de la pestaña».', 'No audio was shared. Start again and turn on “Also share tab audio”.')); }
    stream.getVideoTracks().forEach(t => t.stop());
    at[0].addEventListener('ended', () => running && stop(T('Se ha dejado de compartir la pestaña.', 'Tab sharing stopped.')));
    await engine.startStream(new MediaStream(at));
  } else if (src === 'mic') {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    await engine.startStream(stream);
  } else {
    const v = $('lv-video');
    if (!v.src) throw new Error(T('Elige primero un vídeo o audio.', 'Choose a video or audio first.'));
    await engine.startElement(v);
    v.onended = () => running && stop(T('Fin del vídeo.', 'End of video.'));
    await v.play();
  }
}

async function start() {
  if (running || starting) return;
  if (location.protocol === 'file:' || !window.isSecureContext) return setStatus(T('Abre la web por http://localhost:8000 o HTTPS.', 'Open the site via http://localhost:8000 or HTTPS.'), 'error');
  if (engine.running) return setStatus(T('La grabadora del transcriptor está usando el motor. Detén la grabación primero.', 'The recorder is using the engine. Stop recording first.'), 'error');
  starting = true; $('lv-start').disabled = true; setStatus('');
  engine.h = handlers;
  engine.language = $('lv-lang').value;
  try {
    $('m-state').textContent = T('Cargando modelo…', 'Loading model…');
    await engine.load({ model: lmodel(), proc: lproc() });
    await openSource();
    offset = finals.length ? Math.ceil(finals[finals.length - 1].end) + 1 : 0;
    partial = ''; running = true;
    $('lv-stage').classList.add('is-live');
    $('lv-start').hidden = true; $('lv-stop').hidden = false;
    $$('.src-card').forEach(b => b.disabled = true);
    setStatus(src === 'mic' ? T('Escuchando el micrófono.', 'Listening to the microphone.') : src === 'tab' ? T('Escuchando la pestaña compartida.', 'Listening to the shared tab.') : T('Subtitulando el vídeo.', 'Captioning the video.'), 'ok');
    requestAnimationFrame(drawScope);
    navigator.wakeLock?.request('screen').then(l => (wake = l)).catch(() => {});
  } catch (e) {
    console.error(e);
    engine.stop(); stream?.getTracks().forEach(t => t.stop()); stream = null;
    if (e?.name === 'NotAllowedError') setStatus(src === 'mic' ? T('Permiso de micrófono denegado.', 'Microphone permission denied.') : T('Has cancelado la selección de pestaña.', 'Tab selection cancelled.'), 'error');
    else setStatus(e.message || String(e), 'error');
    $('m-state').textContent = '—';
  } finally { starting = false; $('lv-start').disabled = false; }
}
function stop(msg) {
  if (!running) return;
  engine.stop();               // confirma el texto provisional pendiente
  running = false;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  if (src === 'video') $('lv-video').pause();
  partial = ''; render();
  $('lv-stage').classList.remove('is-live');
  $('lv-start').hidden = false; $('lv-stop').hidden = true;
  $$('.src-card').forEach(b => b.disabled = false);
  setStatus(msg || T('Detenido. El texto queda en el registro.', 'Stopped. The text remains in the log.'));
  wake?.release().catch(() => {}); wake = null;
}
$('lv-start').addEventListener('click', start);
$('lv-stop').addEventListener('click', () => stop());

/* ---------- Herramientas ---------- */
$('lv-fsize').addEventListener('input', e => { $('lv-stage').style.setProperty('--cap', e.target.value + 'px'); render(); });
$('lv-full').addEventListener('click', () => document.fullscreenElement ? document.exitFullscreen() : $('lv-stage').requestFullscreen?.());
document.addEventListener('fullscreenchange', () => {
  const st = $('lv-stage');
  if (document.fullscreenElement === st) st.style.removeProperty('--cap'); else st.style.setProperty('--cap', $('lv-fsize').value + 'px');
  render();
});
$('lv-ts').addEventListener('change', e => $('lv-log').classList.toggle('no-ts', !e.target.checked));
const asText = () => finals.map(f => ($('lv-ts').checked ? `[${fmt(f.start)}] ` : '') + f.text).join('\n');
function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
$('lv-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(asText()); setStatus(T('Texto copiado.', 'Text copied.'), 'ok'); } catch { setStatus(T('No se ha podido copiar.', 'Could not copy.'), 'error'); } });
$('lv-txt').addEventListener('click', () => finals.length ? download(`subtitulos_${stamp()}.txt`, asText()) : setStatus(T('Aún no hay texto.', 'No text yet.')));
$('lv-srt').addEventListener('click', () => finals.length
  ? download(`subtitulos_${stamp()}.srt`, finals.map((f, i) => `${i + 1}\n${fmtSrt(f.start)} --> ${fmtSrt(Math.max(f.end, f.start + 1))}\n${f.text}\n`).join('\n'), 'application/x-subrip')
  : setStatus(T('Aún no hay texto.', 'No text yet.')));
$('lv-clear').addEventListener('click', () => {
  finals.length = 0; offset = 0;
  $('lv-log').innerHTML = `<p class="log-empty">${T('Las frases confirmadas aparecerán aquí.', 'Confirmed sentences will appear here.')}</p>`;
  $('lv-count').textContent = ''; render();
});
window.addEventListener('resize', render);

/* ---------- GPU ---------- */
(async () => {
  let label = '';
  try {
    const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    gpuReady = !!a && !(a.info?.isFallbackAdapter ?? a.isFallbackAdapter);
    label = [a?.info?.vendor, a?.info?.architecture].filter(Boolean).join(' ');
  } catch {}
  $('lv-device').dataset.state = gpuReady ? 'ok' : 'warn';
  const paint = () => $('lv-device-text').textContent = gpuReady
    ? T(`GPU lista${label ? ' · ' + label : ''}: poco retraso`, `GPU ready${label ? ' · ' + label : ''}: low delay`)
    : T('Sin GPU: funcionará con CPU y más retraso (usa Tiny)', 'No GPU: runs on CPU with more delay (use Tiny)');
  paint(); $('lang').addEventListener('click', () => setTimeout(paint, 0));
  if (!gpuReady) document.querySelector('input[name=lmodel][value$="tiny"]').checked = true;
})();
