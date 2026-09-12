#!/usr/bin/env node
// Combine animated WebP files into a single MP4, with a numbered black title
// card before each clip.
//
// Requires only ffmpeg 7.1+ (for its native animated-WebP decoder). No npm
// packages, no libwebp tools, no libfreetype -- the numbers are stroked from
// vector outlines and rasterised with antialiasing into a PNG using Node's
// built-in zlib, so the drawtext filter is never needed.
//
//   node webp2mp4-purejs.js out.mp4 a.webp b.webp c.webp

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const SCALE = 1;              // upscale factor; 1 keeps the original 320x180
const CARD_SECONDS = 0.75;  // how long each "#n" card holds
const FPS = 24;             // output frame rate
const TEXT_HEIGHT = 0.34;   // cap height as a fraction of frame height
const STROKE = 0.135;       // stroke weight in em units

// ---------------------------------------------------------------- glyph shapes

// Each glyph is a set of polylines in em units: x right, y down, 0..1 tall.
// Curves are arcs flattened into short segments; the renderer strokes them with
// round caps and joins, which is why a circle can just be one closed polyline.
const P = (x, y) => ({ x, y });

function arc(cx, cy, r, a0, a1, n = 28) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    pts.push(P(cx + r * Math.cos(a), cy - r * Math.sin(a)));
  }
  return pts;
}
const circle = (cx, cy, r) => arc(cx, cy, r, 0, 360, 44);

const GLYPHS = {
  '#': { w: 0.60, strokes: [
    [P(0.22, 0.10), P(0.14, 0.90)],
    [P(0.44, 0.10), P(0.36, 0.90)],
    [P(0.05, 0.36), P(0.55, 0.36)],
    [P(0.03, 0.64), P(0.53, 0.64)],
  ]},
  '0': { w: 0.62, strokes: [
    [...arc(0.31, 0.31, 0.25, 180, 0), ...arc(0.31, 0.69, 0.25, 0, -180),
     P(0.06, 0.69), P(0.06, 0.31)],
  ]},
  '1': { w: 0.62, strokes: [[P(0.16, 0.22), P(0.32, 0.06), P(0.32, 0.94)]] },
  '2': { w: 0.62, strokes: [
    [...arc(0.31, 0.32, 0.25, 180, -20), P(0.08, 0.94)],
    [P(0.05, 0.94), P(0.58, 0.94)],
  ]},
  '3': { w: 0.62, strokes: [
    [...arc(0.31, 0.31, 0.25, 160, -60)],
    [...arc(0.31, 0.69, 0.25, 60, -165)],
  ]},
  '4': { w: 0.62, strokes: [
    [P(0.44, 0.06), P(0.04, 0.70), P(0.60, 0.70)],
    [P(0.44, 0.06), P(0.44, 0.94)],
  ]},
  '5': { w: 0.62, strokes: [
    [P(0.54, 0.07), P(0.14, 0.07), P(0.12, 0.40), ...arc(0.30, 0.67, 0.27, 90, -165)],
  ]},
  '6': { w: 0.62, strokes: [
    [...arc(0.31, 0.33, 0.26, 70, 180), P(0.05, 0.68)],
    [...circle(0.31, 0.68, 0.26)],
  ]},
  '7': { w: 0.62, strokes: [[P(0.05, 0.08), P(0.57, 0.08), P(0.22, 0.94)]] },
  '8': { w: 0.62, strokes: [
    [...circle(0.31, 0.27, 0.21)],
    [...circle(0.31, 0.73, 0.23)],
  ]},
  '9': { w: 0.62, strokes: [
    [...circle(0.31, 0.32, 0.26)],
    [P(0.57, 0.32), P(0.57, 0.67)],
    [...arc(0.31, 0.67, 0.26, 0, -110)],
  ]},
};

// ------------------------------------------------------------- PNG rasteriser

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ux = px - (a.x + t * dx);
  const uy = py - (a.y + t * dy);
  return Math.sqrt(ux * ux + uy * uy);
}

// White text centred on black, as an 8-bit greyscale PNG. Coverage comes from
// the distance to the nearest stroke, which gives smooth edges for free.
function makeCard(width, height, text) {
  const em = Math.round(height * TEXT_HEIGHT);
  const tracking = 0.06;

  let textW = -tracking;
  for (const ch of text) textW += (GLYPHS[ch]?.w ?? 0.5) + tracking;

  let penX = (width - textW * em) / 2;
  const originY = (height - em) / 2;

  // one filter byte (0 = none) at the start of each scanline
  const raw = Buffer.alloc(height * (width + 1));

  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (!glyph) continue;

    // only touch pixels inside the glyph's bounding box, padded for the stroke
    const x0 = Math.max(0, Math.floor(penX - em * STROKE));
    const x1 = Math.min(width - 1, Math.ceil(penX + em * (glyph.w + STROKE)));
    const y0 = Math.max(0, Math.floor(originY - em * STROKE));
    const y1 = Math.min(height - 1, Math.ceil(originY + em * (1 + STROKE)));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x + 0.5 - penX) / em;
        const ny = (y + 0.5 - originY) / em;

        let dist = Infinity;
        for (const poly of glyph.strokes) {
          for (let i = 0; i < poly.length - 1; i++) {
            const d = distToSegment(nx, ny, poly[i], poly[i + 1]);
            if (d < dist) dist = d;
          }
        }

        // one pixel of falloff either side of the stroke edge
        let alpha = (STROKE / 2 - dist) * em + 0.5;
        alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
        if (alpha > 0) {
          const value = Math.round(alpha * 255);
          const i = y * (width + 1) + 1 + x;
          if (value > raw[i]) raw[i] = value;
        }
      }
    }
    penX += em * (glyph.w + tracking);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type 0 = greyscale

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ----------------------------------------------------------------------- main

async function main() {
  const [output, ...inputs] = process.argv.slice(2);
  if (!output || inputs.length === 0) {
    console.error('usage: node webp2mp4-purejs.js <out.mp4> <in1.webp> [in2.webp ...]');
    process.exit(1);
  }

  await assertAnimatedWebpSupport();

  const { width, height } = await probeSize(inputs[0]);
  const outW = width * SCALE;
  const outH = height * SCALE;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'webp2mp4-'));

  try {
    const args = ['-y', '-v', 'error'];

    // clip inputs first...
    for (const file of inputs) args.push('-i', file);

    // ...then one looped still image per card
    for (let i = 0; i < inputs.length; i++) {
      const card = path.join(tmp, `card${i}.png`);
      await fs.writeFile(card, makeCard(outW, outH, `#${i + 1}`));
      args.push('-loop', '1', '-framerate', String(FPS), '-t', String(CARD_SECONDS),
                '-i', card);
    }

    // concat demands identical size, rate, SAR and pixel format on every input
    const norm = `scale=${outW}:${outH}:flags=neighbor,fps=${FPS},setsar=1,format=yuv420p`;
    const parts = [];
    const order = [];

    inputs.forEach((_, i) => {
      parts.push(`[${inputs.length + i}:v]${norm}[c${i}]`);
      parts.push(`[${i}:v]${norm}[v${i}]`);
      order.push(`[c${i}][v${i}]`);
    });
    parts.push(`${order.join('')}concat=n=${inputs.length * 2}:v=1:a=0[out]`);

    args.push(
      '-filter_complex', parts.join(';'),
      '-map', '[out]',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
      output
    );

    inputs.forEach((f, i) => console.log(`#${i + 1} ${path.basename(f)}`));
    await run('ffmpeg', args);
    console.log(`wrote ${output} (${outW}x${outH})`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ffmpeg gained an animated-WebP decoder in 7.1; older builds silently see
// only the first frame, so fail loudly instead of producing a broken video.
async function assertAnimatedWebpSupport() {
  const out = await capture('ffmpeg', ['-hide_banner', '-version']);
  const m = out.match(/ffmpeg version n?(\d+)\.(\d+)/i);
  if (!m) return; // unknown build (git master etc) -- let it try
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major < 7 || (major === 7 && minor < 1)) {
    throw new Error(
      `ffmpeg ${major}.${minor} cannot decode animated WebP (needs 7.1+). ` +
      `Run: brew upgrade ffmpeg`
    );
  }
}

async function probeSize(file) {
  const out = await capture('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ]);
  const [width, height] = out.trim().split(',').map(Number);
  if (!width || !height) throw new Error(`could not read dimensions from ${file}`);
  return { width, height };
}

function capture(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) =>
      reject(new Error(e.code === 'ENOENT' ? `${cmd} not found on PATH` : e.message))
    );
    p.on('close', () => resolve(out));
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('error', (e) =>
      reject(new Error(e.code === 'ENOENT' ? `${cmd} not found on PATH` : e.message))
    );
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))
    );
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
