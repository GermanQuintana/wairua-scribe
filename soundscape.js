// Wairua Scribe — paisaje sonoro del hero
// Ondas luminosas y notas musicales que reaccionan al paso del cursor
// (o del dedo) y generan ondas expansivas al hacer clic.

const canvas = document.getElementById('soundscape');
const hero = document.getElementById('hero');
const ctx = canvas.getContext('2d', { alpha: true });
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

let W = 0, H = 0, DPR = 1, running = false, visible = true, last = 0, t0 = performance.now();
const pointer = { x: -9999, y: -9999, sx: -9999, sy: -9999, speed: 0, energy: 0, inside: false };
const ripples = [];
let notes = [];

// Paleta Wairua (de cian luminoso a azul profundo)
const LINES = [
  { amp: 34, freq: 0.0042, speed: 0.38, off: 0.0, width: 1.6, alpha: 0.85, hue: [120, 220, 255] },
  { amp: 46, freq: 0.0031, speed: -0.27, off: 1.3, width: 1.1, alpha: 0.55, hue: [34, 193, 241] },
  { amp: 26, freq: 0.0058, speed: 0.52, off: 2.1, width: 0.9, alpha: 0.45, hue: [60, 150, 235] },
  { amp: 58, freq: 0.0022, speed: 0.21, off: 3.4, width: 2.4, alpha: 0.22, hue: [11, 108, 192] },
  { amp: 18, freq: 0.0074, speed: -0.6, off: 4.2, width: 0.7, alpha: 0.4, hue: [160, 230, 255] },
  { amp: 40, freq: 0.0036, speed: 0.33, off: 5.0, width: 1.0, alpha: 0.3, hue: [34, 140, 220] },
  { amp: 70, freq: 0.0017, speed: -0.16, off: 5.9, width: 3.2, alpha: 0.12, hue: [6, 66, 138] },
];
const GLYPHS = ['♪', '♫', '♬', '♩', '♪', '♫'];

// Sprites de notas con resplandor, pre-renderizados para rendimiento
const sprites = {};
function makeSprite(glyph) {
  const s = 128, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `72px "Instrument Serif", "Segoe UI Symbol", "Apple Symbols", serif`;
  g.shadowColor = 'rgba(34,193,241,.95)'; g.shadowBlur = 22;
  g.fillStyle = 'rgba(170,230,255,1)';
  g.fillText(glyph, s / 2, s / 2 + 4);
  g.shadowBlur = 0; g.fillStyle = 'rgba(235,248,255,1)';
  g.fillText(glyph, s / 2, s / 2 + 4);
  return c;
}
function getSprite(gl) { return sprites[gl] || (sprites[gl] = makeSprite(gl)); }

function baseY(line, x, t, li) {
  const mid = H * (W < 700 ? 0.8 : 0.76);
  return mid + (li - 3) * 9
    + Math.sin(x * line.freq + t * line.speed + line.off) * line.amp
    + Math.sin(x * line.freq * 2.3 - t * line.speed * 0.7 + line.off * 2) * line.amp * 0.28;
}

// Desplazamiento por cursor y ondas expansivas
function disturb(x, y0, t) {
  let dy = 0;
  if (pointer.sx > -999) {
    const dx = x - pointer.sx;
    const fall = Math.exp(-(dx * dx) / (2 * 150 * 150));
    const pull = (pointer.sy - y0);
    const lim = 90 + pointer.energy * 60;
    dy += fall * Math.max(-lim, Math.min(lim, pull * (0.28 + pointer.energy * 0.25)));
    dy += fall * Math.sin(dx * 0.045 - t * 9) * pointer.energy * 22;
  }
  for (const r of ripples) {
    const d = Math.hypot(x - r.x, y0 - r.y);
    const band = d - r.r;
    if (Math.abs(band) < 120) dy += Math.sin(band * 0.06) * r.a * Math.exp(-(band * band) / 3000);
  }
  return dy;
}

function initNotes() {
  const count = Math.round(Math.min(46, Math.max(16, W / 34)));
  notes = Array.from({ length: count }, (_, i) => spawnNote(i, true));
}
function spawnNote(i, initial) {
  const depth = 0.35 + Math.random() * 0.65;
  return {
    glyph: GLYPHS[i % GLYPHS.length],
    x: initial ? Math.random() * W : -40,
    lane: Math.floor(Math.random() * LINES.length),
    yo: (Math.random() - 0.5) * 140,
    vx: 0, vy: 0, px: 0, py: 0,
    drift: (8 + Math.random() * 18) * depth,
    size: (14 + Math.random() * 26) * depth,
    depth,
    rot: (Math.random() - 0.5) * 0.5,
    spin: 0,
    phase: Math.random() * Math.PI * 2,
    alpha: 0.25 + depth * 0.6,
  };
}

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  initNotes();
  if (!running) draw(performance.now());
}

function draw(now) {
  const t = (now - t0) / 1000;
  const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;

  // suavizado del puntero y energía según velocidad
  if (pointer.x > -999) {
    if (pointer.sx < -999) { pointer.sx = pointer.x; pointer.sy = pointer.y; }
    const nx = pointer.sx + (pointer.x - pointer.sx) * 0.12;
    const ny = pointer.sy + (pointer.y - pointer.sy) * 0.12;
    const v = Math.hypot(nx - pointer.sx, ny - pointer.sy) / Math.max(dt, 0.001);
    pointer.sx = nx; pointer.sy = ny;
    pointer.energy += (Math.min(1, v / 1400) - pointer.energy) * 0.08;
  } else {
    pointer.energy *= 0.94;
    if (pointer.energy < 0.01) pointer.sx = pointer.sy = -9999;
  }

  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i]; r.r += 520 * dt; r.a *= 0.965;
    if (r.a < 0.4) ripples.splice(i, 1);
  }

  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';

  // Ondas: un trazo ancho y tenue (halo) + un trazo fino y brillante
  const step = W > 1200 ? 6 : 5;
  for (let li = 0; li < LINES.length; li++) {
    const L = LINES[li];
    ctx.beginPath();
    for (let x = -10; x <= W + 10; x += step) {
      const y0 = baseY(L, x, t, li);
      const y = y0 + disturb(x, y0, t) * (0.6 + L.alpha * 0.6);
      x === -10 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    const [r, g, b] = L.hue;
    grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
    grad.addColorStop(0.18, `rgba(${r},${g},${b},${L.alpha})`);
    grad.addColorStop(0.82, `rgba(${r},${g},${b},${L.alpha})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = L.width * 6; ctx.globalAlpha = 0.08 + pointer.energy * 0.06;
    ctx.stroke();
    ctx.lineWidth = L.width; ctx.globalAlpha = 1;
    ctx.stroke();
  }

  // Anillos de las ondas expansivas
  for (const r of ripples) {
    ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(120,215,255,${Math.min(0.35, r.a / 120)})`;
    ctx.lineWidth = 1; ctx.stroke();
  }

  // Notas que flotan sobre las ondas y huyen del cursor
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const L = LINES[n.lane];
    n.x += n.drift * dt;
    const homeY = baseY(L, n.x, t, n.lane) + n.yo * n.depth + Math.sin(t * 0.8 + n.phase) * 10;
    const hx = n.x + n.px, hy = homeY + n.py;

    if (pointer.sx > -999) {
      const dx = hx - pointer.sx, dy = hy - pointer.sy;
      const d = Math.hypot(dx, dy) || 1;
      const R = 170 + pointer.energy * 90;
      if (d < R) {
        const f = (1 - d / R) ** 2 * (900 + pointer.energy * 2600) * n.depth;
        n.vx += (dx / d) * f * dt; n.vy += (dy / d) * f * dt;
        n.spin += (dx > 0 ? 1 : -1) * f * 0.0009 * dt;
      }
    }
    for (const r of ripples) {
      const dx = hx - r.x, dy = hy - r.y, d = Math.hypot(dx, dy) || 1;
      if (Math.abs(d - r.r) < 40) { const f = r.a * 6 * n.depth; n.vx += dx / d * f * dt; n.vy += dy / d * f * dt; }
    }
    // muelle de vuelta a su posición
    n.vx += -n.px * 6 * dt; n.vy += -n.py * 6 * dt;
    n.vx *= 0.92; n.vy *= 0.92; n.spin *= 0.95;
    n.px += n.vx * dt * 10; n.py += n.vy * dt * 10;
    n.rot += n.spin;
    n.rot += (Math.sin(t * 0.6 + n.phase) * 0.25 - n.rot) * 0.02;

    if (n.x > W + 60) notes[i] = spawnNote(i, false);

    const x = n.x + n.px, y = homeY + n.py;
    const s = n.size * (1 + Math.min(0.6, Math.hypot(n.vx, n.vy) / 900));
    const edge = Math.min(1, x / 120, (W - x) / 120);
    ctx.save();
    ctx.globalAlpha = Math.max(0, n.alpha * edge);
    ctx.translate(x, y); ctx.rotate(n.rot);
    ctx.drawImage(getSprite(n.glyph), -s, -s, s * 2, s * 2);
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  if (running) requestAnimationFrame(draw);
}

function start() {
  if (running || reduceMotion.matches || !visible || document.hidden) return;
  running = true; last = 0; requestAnimationFrame(draw);
}
function stop() { running = false; }

function setPointer(e) {
  const r = canvas.getBoundingClientRect();
  pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top; pointer.inside = true;
  hero.style.setProperty('--mx', pointer.x + 'px');
  hero.style.setProperty('--my', pointer.y + 'px');
}
hero.addEventListener('pointermove', setPointer, { passive: true });
hero.addEventListener('pointerdown', e => {
  setPointer(e);
  ripples.push({ x: pointer.x, y: pointer.y, r: 0, a: 38 });
  pointer.energy = Math.min(1, pointer.energy + 0.6);
});
hero.addEventListener('pointerleave', () => { pointer.x = pointer.y = -9999; pointer.inside = false; });

new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); }).observe(hero);
document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());
reduceMotion.addEventListener?.('change', () => reduceMotion.matches ? stop() : start());
window.addEventListener('resize', resize);
document.fonts?.ready.then(() => { Object.keys(sprites).forEach(k => delete sprites[k]); });

resize();
start();
