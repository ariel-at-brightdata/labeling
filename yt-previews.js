#!/usr/bin/env node
// Scrape YouTube hover-preview animations for one or more channels, then build
// one MP4 per channel by feeding them to webp2mp4-purejs.js.
//
//   node yt-previews.js                        # reads ./channels.txt
//   node yt-previews.js --file "talking heads" # reads that list (.txt optional)
//   node yt-previews.js https://www.youtube.com/@handle [more URLs...]
//
// Each list gets its own output directory, named after the list file, so two
// lists never overwrite each other:
//
//   talking heads/mp4/<channelId>.mp4
//   talking heads/webp/<channelId>/*.webp
//   talking heads/report.txt
//
// channels.txt holds one channel URL per line; blank lines and #comments are
// skipped. Ten channels in, ten MP4s out.
//
// Layout:
//   webp/<channel>/01_<videoId>_<title>.webp   (+ manifest.json)
//   mp4/<channel>.mp4
//
// The preview URLs are signed by YouTube (sqp/rs query params); an unsigned
// i.ytimg.com/an_webp/<id>/mqdefault_6s.webp returns 404, so they must be read
// out of the channel page's ytInitialData. Only the initial HTML render of the
// /videos tab carries them -- the InnerTube browse API and scroll
// continuations return none.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PER_CHANNEL = 6;                 // clips per channel, per the spec
const STRIDE = 4;                      // sample every 4th video: #1, #5, #9, ...
const REPORT = 'report.txt';           // written at the end of every run
const MIN_SCORE = 5;                   // default cutoff for scored CSV lists
const DEFAULT_LIST = 'channels.txt';

// ------------------------------------------------------------------ fetching

async function get(url, asText = true) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,image/webp,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 80)}`);
  return asText ? res.text() : Buffer.from(await res.arrayBuffer());
}

// --------------------------------------------------------------- url helpers

const UC_ID = /^UC[\w-]{20,}$/;

// Accepted per line: a raw UC id, an @handle, or any youtube.com channel URL.
function looksLikeChannel(line) {
  return UC_ID.test(line) || line.startsWith('@') || /youtube\.com\//i.test(line);
}

function videosUrl(input) {
  let u = String(input).trim().replace(/\/+$/, '');
  if (!u) return null;
  if (UC_ID.test(u)) return `https://www.youtube.com/channel/${u}/videos`;
  if (u.startsWith('@')) u = 'https://www.youtube.com/' + u;
  if (!/^https?:\/\//.test(u)) u = 'https://www.youtube.com/' + u.replace(/^\/+/, '');
  if (/\/(videos|shorts|streams)$/.test(u)) return u;
  return u.replace(/\/featured$/, '') + '/videos';
}

// Names the mp4 and the webp subfolder. Prefer the canonical UC id that the
// page reports, so an @handle and its UC id produce the same filename; fall
// back to whatever the URL carries if the page omits it.
function channelId(url, data) {
  const external = data?.metadata?.channelMetadataRenderer?.externalId ||
                   collect(data?.metadata || {}, 'externalId')[0];
  if (external && UC_ID.test(external)) return external;
  const m = url.match(/\/channel\/(UC[\w-]+)/) || url.match(/\/@([\w.-]+)/);
  return (m ? m[1] : 'channel').replace(/\./g, '_');
}

// ------------------------------------------------------------------ list files

// RFC 4180: fields may be quoted, and a quoted field may contain commas,
// doubled quotes and newlines -- so the file cannot simply be split on \n.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const SCORED_DIR = 'scored_csv';   // where shared lists live, locally and in the repo

// Find the list. A path that exists on disk always wins -- including one under
// ./scored_csv -- so a local file is never shadowed by the repository. Only
// when nothing matches locally is the name fetched from the repo's scored_csv
// folder, which lets a bare --file=pottery_channels work anywhere.
async function resolveList(name, repoSlug, branch = 'main') {
  const withExts = (p) => [p, `${p}.csv`, `${p}.txt`];
  const hasDir = name.includes('/') || name.includes(path.sep);

  const local = hasDir ? withExts(name)
                       : [...withExts(name), ...withExts(path.join(SCORED_DIR, name))];
  for (const candidate of local) {
    try {
      const text = await fs.readFile(candidate, 'utf8');
      return { text, display: candidate, filename: path.basename(candidate) };
    } catch { /* next candidate */ }
  }

  // An explicit path was given and it is not there: do not silently reach out
  // to the network for something the user pointed at on disk.
  if (hasDir) {
    throw new Error(`cannot read ${local.join(' or ')}`);
  }

  const remote = withExts(`https://raw.githubusercontent.com/${repoSlug}/${branch}/` +
                          `${SCORED_DIR}/${encodeURIComponent(name)}`);
  for (const url of remote) {
    try {
      const text = await get(url);
      console.log(`  fetched ${url.split('/').slice(-2).join('/')} from ${repoSlug}`);
      return { text, display: url, filename: path.basename(new URL(url).pathname) };
    } catch { /* next candidate */ }
  }

  throw new Error(
    `cannot find "${name}" locally (tried ${local.join(', ')}) ` +
    `or in ${repoSlug}/${SCORED_DIR}/`);
}

// Accepted list formats: one channel per line, or a CSV carrying a channel_id
// (or url/handle) column, optionally with a score column used in mp4 names.
function readList(text, filename) {
  text = text.replace(/^\uFEFF/, '');            // strip a spreadsheet BOM
  const isCsv = /\.csv$/i.test(filename) ||
                /(^|,)\s*(channel_id|url|handle)\s*(,|$)/i.test(text.split('\n')[0]);
  if (!isCsv) {
    const lines = text.split(/\r?\n/).map((l) => l.trim())
                      .filter((l) => l && !l.startsWith('#'));
    return {
      entries: lines.filter(looksLikeChannel).map((raw) => ({ raw, score: '' })),
      skipped: lines.filter((l) => !looksLikeChannel(l)),
    };
  }

  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) throw new Error(`${filename}: no rows`);

  // Header names are matched loosely, so channel_id, channelID, "Channel ID"
  // and channelid are all the same column.
  const norm = (h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const header = rows[0].map(norm);
  const find = (...names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };

  let idCol = find('channelid', 'ytchannelid', 'youtubechannelid', 'channel',
                   'channelurl', 'channellink', 'url', 'handle', 'link');
  let body = rows.slice(1);

  // No recognisable header: find the column that actually holds channel ids,
  // and keep the first row, which was evidently data rather than a header.
  if (idCol === -1) {
    const looksHeaderless = !rows[0].some((c) => norm(c) && /[a-z]/.test(norm(c)) &&
                                                !looksLikeChannel(c.trim()));
    const sample = (looksHeaderless ? rows : rows.slice(1)).slice(0, 50);
    let best = -1, bestHits = 0;
    for (let c = 0; c < rows[0].length; c++) {
      const hits = sample.filter((r) => looksLikeChannel((r[c] || '').trim())).length;
      if (hits > bestHits) { best = c; bestHits = hits; }
    }
    if (best === -1 || bestHits < Math.max(1, sample.length / 2)) {
      throw new Error(`${filename}: no channel id column found -- name one ` +
                      `"channel_id" (or url, or handle)`);
    }
    idCol = best;
    if (looksHeaderless) body = rows;
    console.log(`  using column ${idCol + 1}` +
                (rows[0][idCol] ? ` ("${rows[0][idCol].trim()}")` : '') +
                ' for channel ids');
  }

  const scoreCol = find('score05', 'score', 'rating');

  const entries = [], skipped = [];
  for (const r of body) {
    const raw = (r[idCol] || '').trim();
    if (!looksLikeChannel(raw)) { if (raw) skipped.push(raw); continue; }
    entries.push({ raw, score: scoreCol === -1 ? '' : (r[scoreCol] || '').trim() });
  }
  return { entries, skipped };
}

// ---------------------------------------------------------------- extraction

// Pull the ytInitialData object out of the page by balancing braces, which
// survives the `};</script>` pattern shifting around between page variants.
function extractInitialData(html) {
  const marker = /(?:var ytInitialData|window\["ytInitialData"\])\s*=\s*\{/;
  const m = html.match(marker);
  if (!m) throw new Error('ytInitialData not found (page layout changed, or blocked)');
  const start = m.index + m[0].length - 1;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('ytInitialData was truncated');
}

function collect(node, key, out = []) {
  if (Array.isArray(node)) {
    for (const v of node) collect(v, key, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      collect(v, key, out);
    }
  }
  return out;
}

function gridItems(data, out = []) {
  if (Array.isArray(data)) {
    for (const v of data) gridItems(v, out);
  } else if (data && typeof data === 'object') {
    if (data.richItemRenderer) out.push(data.richItemRenderer);
    for (const v of Object.values(data)) gridItems(v, out);
  }
  return out;
}

function titleOf(item) {
  const t = item?.content?.lockupViewModel?.metadata
              ?.lockupMetadataViewModel?.title;
  if (t?.content) return t.content;
  for (const cand of collect(item, 'title')) {
    if (cand && typeof cand === 'object') {
      const s = cand.content || cand.simpleText ||
                (cand.runs || []).map((r) => r.text || '').join('');
      if (s) return s;
    } else if (typeof cand === 'string' && cand.length > 5) return cand;
  }
  return '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scrapeWithRetry(channelUrl, tries = 3, log = console.log) {
  let last, lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    let why;
    try {
      last = await scrape(channelUrl);
      lastErr = null;
      if (last.rows.some((r) => r.webp)) return last;
      why = 'no previews in response';
    } catch (err) {
      // A throttled or otherwise odd response can come back without
      // ytInitialData at all; that is just as retryable as an empty one.
      lastErr = err;
      why = err.message;
    }
    if (attempt < tries) {
      log(`  ${why}, retrying (${attempt}/${tries - 1})`);
      await sleep(2000 * attempt);
    }
  }
  if (lastErr) throw lastErr;
  return last;
}

async function scrape(channelUrl) {
  const data = extractInitialData(await get(channelUrl));
  const id = channelId(channelUrl, data);
  const seen = new Set();
  const rows = [];
  for (const item of gridItems(data)) {
    const id = collect(item, 'videoId')[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const webp = collect(item, 'url')
      .find((u) => typeof u === 'string' && u.includes('an_webp'));
    rows.push({ videoId: id, title: titleOf(item), webp: webp || null });
  }
  return { id, rows };
}

// ---------------------------------------------------------------- downloading

const slug = (s) =>
  (s.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 50) || 'video');

// A signed URL that has expired still returns 200 with a tiny placeholder, so
// check for the RIFF/WEBP magic and an ANIM chunk rather than trusting status.
function isAnimatedWebp(buf) {
  return buf.length > 2000 &&
         buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
         buf.subarray(8, 12).toString('latin1') === 'WEBP' &&
         buf.subarray(0, 200).includes(Buffer.from('ANIM'));
}

// Walk the page taking every STRIDE-th video (#1, #5, #9, #13, #17, #21).
// A sampled slot whose video has no preview would otherwise cost us a clip, so
// fall through to the next previewed video after it and carry on from there.
function sample(rows, limit, stride = STRIDE) {
  const picked = [];
  const used = new Set();
  for (let i = 0; i < rows.length && picked.length < limit; i += stride) {
    let j = i;
    while (j < rows.length && (!rows[j].webp || used.has(j))) j++;
    if (j >= rows.length) break;
    used.add(j);
    picked.push({ ...rows[j], position: j + 1 });
  }
  // Page exhausted before the quota (short page, or sparse previews): top up
  // with whatever previewed videos are left, in page order.
  for (let j = 0; j < rows.length && picked.length < limit; j++) {
    if (rows[j].webp && !used.has(j)) {
      used.add(j);
      picked.push({ ...rows[j], position: j + 1 });
    }
  }
  return picked;
}

async function downloadClips(rows, dir, limit, log) {
  await fs.mkdir(dir, { recursive: true });
  const files = [], manifest = [];
  const picked = sample(rows, limit);
  if (picked.length) {
    log(`  taking page positions: ${picked.map((p) => '#' + p.position).join(' ')}`);
  }
  for (const row of picked) {
    let buf;
    try {
      buf = await get(row.webp, false);
    } catch (err) {
      log(`  ! ${row.videoId}: ${err.message}`);
      continue;
    }
    if (!isAnimatedWebp(buf)) {
      log(`  ! ${row.videoId}: not an animated webp (${buf.length} bytes)`);
      continue;
    }
    const n = files.length + 1;
    const name = `${String(n).padStart(2, '0')}_p${String(row.position).padStart(2, '0')}` +
                 `_${row.videoId}_${slug(row.title)}.webp`;
    const file = path.join(dir, name);
    await fs.writeFile(file, buf);
    files.push(file);
    manifest.push({ ...row, file: name, bytes: buf.length });
    log(`  [${n}/${limit}] ${name} (${Math.round(buf.length / 1024)} KB)`);
    await new Promise((r) => setTimeout(r, 400));
  }
  await fs.writeFile(path.join(dir, 'manifest.json'),
                     JSON.stringify(manifest, null, 2));
  return files;
}

// ============================================================================
// Animated WebP -> MP4. Folded in from webp2mp4-purejs.js so this file is the
// only one needed: ffmpeg 7.1+ for the animated-WebP decoder, and the "#n"
// title cards rasterised here from vector outlines via zlib, so no fonts and
// no drawtext filter are required.
// ============================================================================

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

// ffmpeg gained an animated-WebP decoder in 7.1; older builds silently see
// only the first frame, so fail loudly instead of producing a broken video.
async function assertAnimatedWebpSupport() {
  const { out } = await capture('ffmpeg', ['-hide_banner', '-version']);
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
  const { out } = await capture('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ]);
  const [width, height] = out.trim().split(',').map(Number);
  if (!width || !height) throw new Error(`could not read dimensions from ${file}`);
  return { width, height };
}

// Run a command, collecting its output rather than inheriting the terminal.
function capture(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) =>
      reject(new Error(e.code === 'ENOENT' ? `${cmd} not found on PATH` : e.message)));
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function runFfmpeg(args) {
  const { code, out } = await capture('ffmpeg', args);
  if (code !== 0) throw new Error(`ffmpeg failed: ${out.trim().split('\n').pop()}`);
}

// Build one mp4: a numbered card before each clip, all normalised to the same
// size, rate, SAR and pixel format because concat demands it.
async function buildMp4(output, inputs, log) {
  const { width, height } = await probeSize(inputs[0]);
  const outW = Math.round(width * SCALE);
  const outH = Math.round(height * SCALE);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-previews-'));
  try {
    const args = ['-y', '-v', 'error'];
    for (const file of inputs) args.push('-i', file);
    for (let i = 0; i < inputs.length; i++) {
      const card = path.join(tmp, `card${i}.png`);
      await fs.writeFile(card, makeCard(outW, outH, `#${i + 1}`));
      args.push('-loop', '1', '-framerate', String(FPS),
                '-t', String(CARD_SECONDS), '-i', card);
    }

    const norm = `scale=${outW}:${outH}:flags=neighbor,fps=${FPS},setsar=1,format=yuv420p`;
    const parts = [], order = [];
    inputs.forEach((_, i) => {
      parts.push(`[${inputs.length + i}:v]${norm}[c${i}]`);
      parts.push(`[${i}:v]${norm}[v${i}]`);
      order.push(`[c${i}][v${i}]`);
    });
    parts.push(`${order.join('')}concat=n=${inputs.length * 2}:v=1:a=0[out]`);

    args.push('-filter_complex', parts.join(';'), '-map', '[out]',
              '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
              '-pix_fmt', 'yuv420p', output);

    await runFfmpeg(args);
    log(`  wrote ${output} (${outW}x${outH})`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------- converting

// Run up to `concurrency` jobs at once, handing each result to `onDone` as it
// finishes. Input order is preserved through the index carried alongside.
async function pool(items, concurrency, worker, onDone) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      onDone(i, await worker(items[i], i));
    }
  });
  await Promise.all(runners);
}

// ------------------------------------------------------------------ uploading

// Every git call runs with terminal prompts disabled: without a credential
// helper, git would otherwise block forever waiting for a username that no one
// is there to type.
function git(args, cwd = '.') {
  return new Promise((resolve) => {
    const p = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => resolve({ code: 127, out: e.message }));
    p.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

const AUTH_HELP = [
  'no GitHub credentials on this machine. Set up one of:',
  '  gh:  brew install gh && gh auth login',
  '  ssh: ssh-keygen -t ed25519, add ~/.ssh/id_ed25519.pub to GitHub, then',
  '       git remote set-url origin git@github.com:<owner>/<repo>.git',
  '  token: export GITHUB_TOKEN=... (used automatically for https remotes)',
].join('\n  ');

// Push the run to GitHub. Returns a short status string for the report.
// Make sure there is a repository, an identity and an origin to push to.
async function gitPrepare(repoUrl) {
  const root = await git(['rev-parse', '--show-toplevel']);
  if (root.code !== 0) {
    if (!repoUrl) {
      throw new Error('not a git repository -- pass --repo=https://github.com/<owner>/<repo>.git');
    }
    console.log('  initialising repository');
    await git(['init', '-b', 'main']);
  }

  if ((await git(['config', 'user.email'])).code !== 0) {
    await git(['config', 'user.email', 'noreply@users.noreply.github.com']);
    await git(['config', 'user.name', 'yt-previews']);
  }

  const remote = await git(['remote', 'get-url', 'origin']);
  if (remote.code !== 0) {
    if (!repoUrl) throw new Error('no origin remote -- pass --repo=<url> once to set it');
    await git(['remote', 'add', 'origin', repoUrl]);
    console.log(`  origin set to ${repoUrl}`);
  } else if (repoUrl && remote.out !== repoUrl) {
    await git(['remote', 'set-url', 'origin', repoUrl]);
    console.log(`  origin changed to ${repoUrl}`);
  }

  // A token in the environment is used for this push only -- it is passed via
  // an ephemeral header, never written into .git/config or any commit.
  const url = (await git(['remote', 'get-url', 'origin'])).out;
  const tokenArgs = [];
  if (process.env.GITHUB_TOKEN && url.startsWith('https://')) {
    const basic = Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString('base64');
    tokenArgs.push('-c', `http.extraheader=Authorization: Basic ${basic}`);
  }
  return { url, tokenArgs };
}

// Rebase onto the remote and push, retrying the whole cycle: another run (or
// another machine) can land a commit in the gap between the two, which git
// reports as a rejected or unlockable ref.
async function pushWithRetry(tokenArgs, attempts = 5) {
  const RACE = /cannot lock ref|non-fast-forward|fetch first|rejected|stale info/i;
  const DENIED = /could not read Username|Authentication failed|Permission denied|403/i;
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'main';

  for (let attempt = 1; ; attempt++) {
    const fetched = await git([...tokenArgs, 'fetch', 'origin', branch]);
    if (fetched.code === 0) {
      const behind = await git(['rev-list', '--count', `HEAD..origin/${branch}`]);
      if (behind.code === 0 && Number(behind.out) > 0) {
        console.log(`  remote is ${behind.out} commit(s) ahead -- rebasing`);
        const rb = await git(['-c', 'rebase.autoStash=true', 'pull', '--rebase',
                              'origin', branch]);
        if (rb.code !== 0) throw new Error(`rebase failed, resolve by hand: ${rb.out}`);
      }
    }

    console.log(attempt === 1 ? '  pushing...' : `  pushing (attempt ${attempt})...`);
    const push = await git([...tokenArgs, 'push', '-u', 'origin', branch]);
    if (push.code === 0) return;

    if (DENIED.test(push.out)) {
      throw new Error(`${AUTH_HELP}\n\n  git said: ${push.out.split('\n')[0]}`);
    }
    if (!RACE.test(push.out) || attempt >= attempts) {
      throw new Error(`push failed: ${push.out}`);
    }
    console.log('  someone else pushed first -- rebasing and trying again');
    await sleep(1500 * attempt);
  }
}

// ---------------------------------------------------------- webp mirroring

// "furniture-woodworking_channels copy" -> "furniture-woodworking_channels",
// so a working copy of a run lands back on the topic it came from.
const topicOfWebpDir = (webpDir) =>
  path.basename(path.dirname(webpDir))
      .replace(/[\s_-]*\bcopy\b[\s_-]*\d*$/i, '')
      .trim();

// Every directory named "webp" under root, at any reasonable depth.
async function findWebpDirs(root, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(root, e.name);
    if (e.name === 'webp') out.push(full);
    else await findWebpDirs(full, depth + 1, out);
  }
  return out;
}

// Additive copy: a file already at the destination is left alone, so re-running
// is cheap and never overwrites what is already published.
async function copyTree(src, dest) {
  let copied = 0, skipped = 0;
  await fs.mkdir(dest, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const from = path.join(src, e.name), to = path.join(dest, e.name);
    if (e.isDirectory()) {
      const r = await copyTree(from, to);
      copied += r.copied;
      skipped += r.skipped;
    } else if (e.isFile()) {
      try {
        await fs.access(to);
        skipped++;
      } catch {
        await fs.copyFile(from, to);
        copied++;
      }
    }
  }
  return { copied, skipped };
}

// Mirror every <something>/webp under scanRoot onto <topic>/webp in the repo
// and push it. webp is in .gitignore so ordinary runs stay mp4-only; these are
// staged with -f, which overrides the ignore for these paths alone.
async function webpCopy(scanRoot, repoUrl, doPush) {
  console.log('\n== mirroring webp folders');
  const { tokenArgs, url } = await gitPrepare(repoUrl);
  const top = (await git(['rev-parse', '--show-toplevel'])).out;
  if (!top) throw new Error('not a git repository');

  const root = path.resolve(scanRoot);
  console.log(`  scanning ${root}`);
  const dirs = await findWebpDirs(root);
  if (!dirs.length) throw new Error(`no folders named "webp" under ${root}`);

  const staged = [];
  let totalCopied = 0, totalSkipped = 0;
  for (const src of dirs.sort()) {
    const topic = topicOfWebpDir(src);
    if (!topic) {
      console.log(`  ! ${src}: cannot tell which topic this belongs to, skipping`);
      continue;
    }
    const dest = path.join(top, topic, 'webp');
    if (path.resolve(src) === path.resolve(dest)) {
      console.log(`  ${topic}/webp is already in place`);
    } else {
      const { copied, skipped } = await copyTree(src, dest);
      totalCopied += copied;
      totalSkipped += skipped;
      const shown = path.relative(root, src) || src;
      console.log(`  ${shown} -> ${topic}/webp  (${copied} copied` +
                  (skipped ? `, ${skipped} already there` : '') + ')');
    }
    staged.push(path.relative(top, dest));
  }

  for (const rel of staged) {
    const add = await git(['add', '-f', '--', rel]);
    if (add.code !== 0) throw new Error(`git add failed for ${rel}: ${add.out}`);
  }

  // Only what was staged under these paths: anything else the user had staged
  // stays out of this commit.
  const cached = await git(['diff', '--cached', '--name-only', '--', ...staged]);
  if (!cached.out) {
    console.log('  nothing new to publish');
    return 'nothing to push';
  }
  const files = cached.out.split('\n').length;
  console.log(`  ${totalCopied} file(s) copied, ${totalSkipped} already present, ` +
              `${files} staged for commit`);

  if (!doPush) {
    console.log('  --upload=false: staged but not committed');
    return 'staged, not pushed';
  }

  const msg = `webp: mirror ${staged.length} folder(s), ${files} file(s)`;
  const commit = await git(['commit', '-m', msg, '--', ...staged]);
  if (commit.code !== 0) throw new Error(`commit failed: ${commit.out}`);
  console.log(`  committed: ${msg}`);

  await pushWithRetry(tokenArgs);
  const webUrl = url.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  console.log(`  pushed to ${webUrl}`);
  return `pushed ${files} webp file(s) to ${webUrl}`;
}

async function upload(outDir, repoUrl, summary) {
  console.log('\n== uploading to GitHub');

  const { url, tokenArgs } = await gitPrepare(repoUrl);

  await git(['add', '-A']);
  const pending = await git(['status', '--porcelain']);
  if (!pending.out) {
    console.log('  nothing changed since the last upload');
    return 'nothing to push';
  }

  const built = summary.filter((r) => r.clips > 0).length;
  const files = pending.out.split('\n').length;
  const msg = `${outDir}: ${built} channel(s), ${files} file(s) changed`;
  const commit = await git(['commit', '-m', msg]);
  if (commit.code !== 0) throw new Error(`commit failed: ${commit.out}`);
  console.log(`  committed: ${msg}`);

  await pushWithRetry(tokenArgs);

  const webUrl = url.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  console.log(`  pushed to ${webUrl}`);
  return `pushed to ${webUrl} (${msg})`;
}

// ============================================================================
// Labelling CSV. Folded in from make-csv.js: one row per mp4, pointing at the
// file's raw URL on GitHub.
// ============================================================================

// description, Instructions and the demo videos now live in the topic's JSON,
// so the sheet carries only what varies per row plus the labellers' columns.
const CSV_COLUMNS = ['topic', 'video_url',
                     'user1 decision', 'user1 decision date', 'user2',
                     'user3 decision date', 'user3', 'user3 decision date'];

// The fixed opening of every topic's instructions. It ends mid-sentence: what
// the labeller must look for is appended to it, per topic.
const INSTRUCTIONS_PREFIX =
  'You will see a series of short previews of videos from a certain category. ' +
  'They should give a general idea of what the videos are about.  It does not ' +
  'have to be 100%; It is OK to have brief parts where there is a static ' +
  'image, for example. Decide if the total impression of the video you saw ' +
  'fits the category. If you are not sure, say no.\n\n' +
  'IMPORTANT: In this category, we need to see ';

// mp4 files are named <channelId>.mp4 or <channelId>-score-<n>.mp4.
const channelOf = (file) => file.replace(/\.mp4$/, '').replace(/-score-[^-]*$/, '');

// Topics that are scratch lists rather than labelling categories: no CSV.
const CSV_SKIP = new Set(['channels', 'pottery_channels', 'tutorials']);

const CSV_DIR = 'csv';      // the labelling sheets and their metadata

// Metadata sits beside its CSV as csv/<topic>.json, so one folder holds both.
const metaPath = (dir) => path.join(CSV_DIR, `${dir}.json`);

async function readMeta(dir) {
  // Runs made before the move kept it inside the run directory.
  for (const p of [metaPath(dir), path.join(dir, 'meta.json')]) {
    try {
      return JSON.parse(await fs.readFile(p, 'utf8'));
    } catch { /* try the next location */ }
  }
  return null;
}

async function saveMeta(dir, meta) {
  await fs.mkdir(CSV_DIR, { recursive: true });
  await fs.writeFile(metaPath(dir), JSON.stringify(meta, null, 2) + '\n');
  return metaPath(dir);
}

// Ask for the three labelling fields up front, so a run never silently
// produces a CSV with a blank Instructions column. Previous answers (or the
// built-in CRITERIA) are offered as defaults; Enter accepts them.
async function askMeta(dir, preset, askFn, opts = {}) {
  const prior = await readMeta(dir);
  const fallbackTopic = prior?.topic || dir;
  // Only the appended part is re-offered, not the fixed opening.
  const priorSuffix = prior?.instructions?.startsWith(INSTRUCTIONS_PREFIX)
    ? prior.instructions.slice(INSTRUCTIONS_PREFIX.length)
    : (prior?.instructions || '');
  const fields = [
    ['topic', 'Friendly topic name', prior?.topic || dir],
    ['instructions', 'Instructions', priorSuffix, 'prefixed'],
    ['description', 'Description', prior?.description || `videos of ${fallbackTopic}`],
  ];

  // The demo examples are only asked for when setting a topic up, since which
  // videos are good or bad is not known until the clips have been watched.
  if (opts.demos) {
    fields.push(
      ['bad', "Two bad example channel ids (comma separated, '-' for none)",
       (prior?.bad || []).join(', '), 'list'],
      ['good', "Two good example channel ids (comma separated, '-' for none)",
       (prior?.good || []).join(', '), 'list'],
    );
  }

  // Anything supplied on the command line is taken as given, not asked for.
  const answers = {};
  const missing = fields.filter(([key]) => {
    const given = preset[key];
    if (Array.isArray(given) ? given.length : given) { answers[key] = given; return false; }
    return true;
  });

  if (missing.length) {
    if (!askFn && !process.stdin.isTTY) {
      throw new Error(
        `${missing.map(([k]) => '--' + k).join(', ')} must be given on the command ` +
        `line when there is no terminal to prompt on`);
    }

    let rl;
    let ask = askFn;
    if (!ask) {
      const readline = require('readline/promises');
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      // Ctrl-D (or a closed pipe) must end the run, not spin on an empty answer.
      let closed = false;
      rl.on('close', () => { closed = true; });
      ask = async (q) => {
        const a = await rl.question(q);
        if (closed && !a) throw new Error('input ended before all fields were given');
        return a;
      };
    }

    try {
      console.log('\nLabelling fields for this run (Enter accepts the default):');
      for (const [key, label, fallback, type] of missing) {
        for (let attempt = 1; ; attempt++) {
          if (type === 'prefixed' && attempt === 1) {
            console.log(`\n${label} -- this fixed text always comes first:\n`);
            console.log(INSTRUCTIONS_PREFIX.split('\n').map((l) => '    ' + l).join('\n'));
            console.log('\n  ...now complete the sentence:');
          }
          const shown = fallback ? `\n  [${fallback}]\n> ` : '\n> ';
          const answer = (await ask(
            type === 'prefixed' ? shown : `\n${label}:${shown}`)).trim();
          const value = answer || fallback;

          if (type === 'prefixed') {
            if (value) { answers[key] = INSTRUCTIONS_PREFIX + value; break; }
            if (attempt >= 3) {
              throw new Error(`no value given for ${label}; pass --${key}=... instead`);
            }
            console.log('  (required -- describe what must be visible)');
            continue;
          }

          if (type === 'list') {
            if (/^(-|none)$/i.test(value)) { answers[key] = []; break; }
            const ids = value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
            const wrong = ids.filter((id) => !UC_ID.test(id));
            if (ids.length && !wrong.length) { answers[key] = ids; break; }
            if (attempt >= 3) {
              throw new Error(`no usable ids for ${label}; pass --${key}=id1,id2 instead`);
            }
            console.log(wrong.length
              ? `  (not a channel id: ${wrong.join(', ')} -- ids look like UCxxxxxxxx...)`
              : "  (enter two channel ids, or '-' for none)");
            continue;
          }

          if (value) { answers[key] = value; break; }
          if (attempt >= 3) {
            throw new Error(`no value given for ${label}; pass --${key}=... instead`);
          }
          console.log('  (required -- please enter a value)');
        }
      }
    } finally {
      if (rl) rl.close();
    }
    console.log('');
  }

  // Carried through rather than asked for: these name the demo videos, and are
  // edited in meta.json once the clips have been watched.
  answers.good = answers.good ?? prior?.good ?? [];
  answers.bad = answers.bad ?? prior?.bad ?? [];

  const written = await saveMeta(dir, answers);
  console.log(`metadata written to ${written}`);
  return answers;
}

// Quote only when a field needs it, so the output diffs cleanly.
const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

// `dir` is the run directory; row values come from its meta.json when one
// exists, falling back to the directory name and the built-in CRITERIA.
async function writeCsv(dir, repoSlug, branch, csvDir) {
  if (CSV_SKIP.has(dir)) return null;
  let mp4s;
  try {
    mp4s = (await fs.readdir(path.join(dir, 'mp4'))).filter((f) => f.endsWith('.mp4')).sort();
  } catch {
    return null;                       // no mp4 directory: nothing to describe
  }
  if (!mp4s.length) return null;

  const meta = (await readMeta(dir)) || {};
  const topic = meta.topic || dir;

  // The good/bad channels are consumed from the JSON, not written into the
  // sheet, but an id matching no mp4 is still worth reporting.
  const present = new Set(mp4s.map(channelOf));
  const stray = [...(meta.good || []), ...(meta.bad || [])].filter((id) => !present.has(id));
  for (const id of stray) {
    console.log(`  ! ${metaPath(dir)} lists ${id}, which has no mp4 in this topic`);
  }

  const lines = [CSV_COLUMNS.join(',')];
  mp4s.forEach((file) => {
    const url = `https://raw.githubusercontent.com/${repoSlug}/${branch}/` +
                [dir, 'mp4', file].map(encodeURIComponent).join('/');
    const values = { topic, video_url: url };
    lines.push(CSV_COLUMNS.map((c) => csvCell(values[c] ?? '')).join(','));
  });

  await fs.mkdir(csvDir, { recursive: true });
  const out = path.join(csvDir, `${dir}.csv`);
  await fs.writeFile(out, lines.join('\n') + '\n');
  return { out, rows: mp4s.length, topic, instructions: meta.instructions };
}

// Derive owner/name from whatever origin is set to, so the URLs in the CSV
// point at the repository this run will actually be pushed to.
// Rebuild the CSV for every topic that has an mp4 directory, no scraping.
async function rebuildAllCsvs() {
  const slug = await repoSlugFromGit();
  const entries = await fs.readdir('.', { withFileTypes: true });
  let total = 0;
  for (const e of entries.filter((d) => d.isDirectory()).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (e.name === 'csv' || e.name.startsWith('.')) continue;
    const written = await writeCsv(e.name, slug, 'main', 'csv');
    if (written) {
      console.log(`${written.out}  ${written.rows} row(s)  topic "${written.topic}"` +
                  (written.instructions ? '' : '  [no instructions]'));
      total++;
    }
  }
  console.log(total ? `\n${total} csv file(s) rebuilt` : 'no topics with an mp4/ directory found');
}

async function repoSlugFromGit(fallback = 'ariel-at-brightdata/labeling') {
  const r = await git(['remote', 'get-url', 'origin']);
  if (r.code !== 0) return fallback;
  const m = r.out.match(/github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/i);
  return m ? m[1] : fallback;
}

// ----------------------------------------------------------------------- main

const HELP = `yt-previews.js -- YouTube hover-preview clips -> one mp4 per channel

Downloads the short animated previews that play when you hover a video
thumbnail, samples every ${STRIDE}th video on a channel's page, and stitches
${PER_CHANNEL} of them into a single mp4 with numbered title cards. Self
contained: needs only node and ffmpeg 7.1+ (with ffprobe).

USAGE
  node yt-previews.js [list or channels] [options]

INPUT
  Reads ./channels.txt when given nothing. A list may be .txt (one channel per
  line) or .csv. Raw UC ids, full URLs and @handles all work and may be mixed;
  header rows, blank lines and #comments are ignored.

  A .csv is read from its channel_id column (or url, or handle). If it also has
  a score_0_5 column, the score is appended to the mp4 name and --min_score
  filters which channels run.

  A bare --file=NAME is looked for in the working directory, then ./scored_csv,
  then the scored_csv folder of the git remote. A name containing a path is
  only ever read from disk, never fetched.

OPTIONS
  Hyphens and underscores are interchangeable: --min-score and --min_score
  both work. An unrecognised --flag is an error, not a channel name.

  --file=NAME        list to read; the .txt/.csv extension is optional
  --limit=N          clips per channel (default ${PER_CHANNEL})
  --min_score=N      for scored CSVs, skip channels below N (default ${MIN_SCORE})
  --parallel=N       channels processed at once (default 1)
  --out=DIR          output directory (default: the list's name)
  --topic=NAME       friendly topic name used in the CSV (asked for if omitted)
  --instructions=... what must be visible; appended to the fixed opening
                     (asked for if omitted)
  --description=...  CSV description column     (asked for if omitted)
  --csv=false        skip writing the labelling CSV, and skip the questions
  --webp_copy=PATH   mirror every <something>/webp under PATH onto <topic>/webp
                     in the repo and push it, then stop. "true" scans the
                     working directory; a "<topic> copy" folder maps back to
                     "<topic>". Pair with --upload=false to copy without
                     committing
  --json-only        ask the questions and write csv/<topic>.json, then stop:
                     no previews are downloaded and no mp4 is built. Also asks
                     for two bad and two good example channel ids
  --good=id1,id2     good example channels   (asked for by --json-only)
  --bad=id1,id2      bad example channels    (asked for by --json-only)
  --csv-only         rebuild every topic's CSV from the mp4s on disk, then exit
  --upload=true      commit the run and push it to GitHub
  --repo=URL         set the git remote; only needed once
  --help             this text

Before anything is downloaded you are asked for three labelling fields: a
friendly topic name (used in the CSV instead of the filename), the labeller
instructions, and the description. Previous answers are offered as defaults and
saved to <list>/meta.json, so a re-run or --csv-only reuses them. Supply them
with --topic/--instructions/--description to skip the questions entirely.

The answers are saved as csv/<topic>.json, beside the sheet itself. That file
also carries "good" and "bad" arrays of channel ids naming the demo videos:

  { "topic": "Pottery", ..., "good": ["UCabc..."], "bad": ["UCxyz..."] }

They start empty; fill them in once you have watched the clips. The CSV itself
carries only the topic and the video urls, since everything else is in the JSON.

OUTPUT
  csv/<list>.json          topic, instructions, description, good/bad channels
  csv/<list>.csv           labelling sheet: topic, video_url, decision columns
  <list>/<list>.txt        copy of the input list used for the run
  <list>/report.txt        which channels had previews and which did not
  <list>/mp4/<id>.mp4      one video per channel
  <list>/webp/<id>/        the source clips + manifest.json

EXAMPLES
  Run the default list:
    node yt-previews.js

  A named list, five channels at a time:
    node yt-previews.js --file=hands1 --parallel=5

  A list whose name has a space (quote it; .txt is optional):
    node yt-previews.js --file="talking heads"

  A scored CSV, keeping only channels scored 4 or 5. A bare name is found in
  ./scored_csv, or fetched from that folder in the repo if it is not local:
    node yt-previews.js --file=pottery_channels --min_score=4 --parallel=5

  Same, but push the results to GitHub when done:
    node yt-previews.js --file=pottery_channels.csv --min_score=4 --upload=true

  First upload ever, naming the repository:
    node yt-previews.js --upload=true --repo=https://github.com/owner/repo.git

  One-off channels, no list file (output lands in output/):
    node yt-previews.js @kingaglyk UC0HOUqH0Sb9pYcxOWxdh6-w

  Ten clips per channel instead of six:
    node yt-previews.js --file=hands1 --limit=10

  Set up a topic's labelling fields and push them, downloading nothing:
    node yt-previews.js --file=pottery_channels --json-only --upload=true

  Publish the source clips from working copies back onto their topics:
    node yt-previews.js --webp_copy="/Users/me/labeling"

  Rebuild all the labelling CSVs without re-running anything:
    node yt-previews.js --csv-only

  Unattended, with the labelling fields supplied so nothing is asked:
    node yt-previews.js --file=pottery_channels --topic="Pottery" \
      --instructions="We need to see clay being shaped..." \
      --description="videos of pottery making" --upload=true

NOTES
  Not every channel exposes previews, and coverage varies: some have 30 of 30,
  others 6 of 30, some none. A channel with none is recorded in report.txt and
  skipped rather than failing the run.

  Uploading uses whatever credentials git already has (gh auth login, an ssh
  key, or GITHUB_TOKEN in the environment). Nothing is stored by this script.
`;

async function main() {
  const argv = process.argv.slice(2);
  const asked = (name) => argv.some((a) =>
    a.replace(/-/g, '_').toLowerCase() === `__${name}`);

  if (asked('help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (asked('csv_only')) {
    await rebuildAllCsvs();
    return;
  }
  const urls = [];
  let limit = PER_CHANNEL;
  let listFile = null;
  let outDir = null;
  let parallel = 1;
  let doUpload = false;
  let uploadGiven = false;      // --upload was passed explicitly
  let repoUrl = null;
  const scoreByRaw = new Map();   // input line -> score, for mp4 filenames
  let minScore = MIN_SCORE;
  let wantCsv = true;
  let listText = null;            // contents of the resolved list, local or remote
  const preset = {};              // labelling fields given on the command line
  let jsonOnly = false;
  let webpCopyFrom = null;
  const KNOWN = ['file', 'limit', 'out', 'parallel', 'upload', 'repo',
                 'min_score', 'csv', 'csv_only', 'help',
                 'topic', 'instructions', 'description', 'json_only',
                 'good', 'bad', 'webp_copy', 'from'];
  const die = (msg) => { console.error(msg); process.exit(1); };
  const num = (raw, flag) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) die(`--${flag} needs a number, got "${raw}"`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { urls.push(a); continue; }

    const m = a.match(/^--([A-Za-z][\w-]*)(?:=([\s\S]*))?$/);
    if (!m) die(`unrecognised argument: ${a}\nrun with --help for usage`);

    // Hyphens and underscores are interchangeable, so --min-score and
    // --min_score both work; an unknown flag is an error rather than being
    // quietly taken for a channel name.
    const flag = m[1].replace(/-/g, '_').toLowerCase();
    const value = m[2] ?? null;

    if (flag === 'file') listFile = value ?? argv[++i];
    else if (flag === 'limit') limit = num(value ?? argv[++i], 'limit');
    else if (flag === 'out') outDir = value ?? argv[++i];
    else if (flag === 'parallel') parallel = Math.max(1, num(value ?? argv[++i], 'parallel'));
    else if (flag === 'upload') {
      doUpload = value === null ? true : !/^(false|0|no)$/i.test(value);
      uploadGiven = true;
    }
    else if (flag === 'repo') repoUrl = value ?? argv[++i];
    else if (flag === 'min_score') minScore = num(value ?? argv[++i], 'min_score');
    else if (flag === 'csv') wantCsv = !/^(false|0|no)$/i.test(value ?? 'true');
    else if (flag === 'topic') preset.topic = value ?? argv[++i];
    else if (flag === 'instructions') preset.instructions = value ?? argv[++i];
    else if (flag === 'description') preset.description = value ?? argv[++i];
    else if (flag === 'json_only') jsonOnly = !/^(false|0|no)$/i.test(value ?? 'true');
    // --webp_copy=true scans the working directory; --webp_copy=PATH scans PATH.
    else if (flag === 'webp_copy') {
      const v = value ?? 'true';
      webpCopyFrom = /^(false|0|no)$/i.test(v) ? null
                   : (/^(true|1|yes)$/i.test(v) ? '.' : v);
    }
    else if (flag === 'from') webpCopyFrom = value ?? argv[++i];
    else if (flag === 'good' || flag === 'bad') {
      preset[flag] = (value ?? argv[++i]).split(/[,\s]+/).filter(Boolean);
    }
    else if (flag === 'csv_only' || flag === 'help') { /* handled before the loop */ }
    else {
      die(`unknown option --${m[1]}\n` +
          `valid options: ${KNOWN.map((k) => '--' + k).join(', ')}\n` +
          `run with --help for usage`);
    }
  }

  if (webpCopyFrom) {
    try {
      const push = uploadGiven ? doUpload : true;
      console.log(await webpCopy(webpCopyFrom, repoUrl, push));
    } catch (err) {
      console.error('  ! ' + err.message);
      process.exitCode = 1;
    }
    return;
  }

  if (jsonOnly) {
    // The topic name is the only thing needed, and it comes from --out or the
    // list's filename -- the list itself is never read.
    const name = outDir ||
      (listFile ? path.basename(listFile).replace(/\.[^.]+$/, '') : null);
    if (!name) {
      console.error('--json-only needs --file=NAME or --out=NAME to name the topic');
      process.exit(1);
    }
    let meta;
    try {
      meta = await askMeta(name, preset, undefined, { demos: true });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    console.log(`topic: ${meta.topic}`);
    if (doUpload) {
      try {
        console.log(await upload(name, repoUrl, []));
      } catch (err) {
        console.error(`\n  ! upload failed: ${err.message}`);
        process.exitCode = 1;
      }
    }
    return;
  }

  // No URLs on the command line means: work through the channel list file.
  if (!urls.length && !listFile) listFile = DEFAULT_LIST;
  if (listFile) {
    let text, listFilename;
    try {
      const found = await resolveList(listFile, await repoSlugFromGit());
      text = found.text;
      listFile = found.display;
      listFilename = found.filename;
    } catch (err) {
      console.error(`${err.message}\n  put one channel per line in a .txt or .csv, ` +
                    `or pass channels as arguments`);
      process.exit(1);
    }
    listText = text;
    let parsed;
    try {
      parsed = readList(text, listFile);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    let belowCutoff = 0;
    for (const e of parsed.entries) {
      if (e.score !== '' && Number(e.score) < minScore) { belowCutoff++; continue; }
      urls.push(e.raw);
      if (e.score !== '') scoreByRaw.set(e.raw, e.score);
    }
    if (belowCutoff) {
      console.log(`  ${belowCutoff} channel(s) below --min_score=${minScore}, skipped`);
    }
    for (const l of parsed.skipped) console.log(`  skipping non-channel line: ${l}`);
    if (scoreByRaw.size) console.log(`  ${scoreByRaw.size} channel(s) carry a score`);
    if (!urls.length) {
      console.error(`${listFile} has no channel URLs in it`);
      process.exit(1);
    }
    console.log(`${urls.length} channel(s) from ${listFile}`);
    if (!outDir) outDir = listFilename.replace(/\.[^.]+$/, '');
  }

  // A list file with no extension would collide with the directory named after
  // it, so step aside rather than failing on mkdir.
  if (!outDir) outDir = 'output';
  if (path.resolve(outDir) === path.resolve(listFile || '')) outDir += '-out';
  await fs.mkdir(outDir, { recursive: true });
  console.log(`output directory: ${outDir}/`);

  // Fail loudly up front rather than after downloading everything.
  await assertAnimatedWebpSupport();

  // Collect the labelling fields before a single channel is fetched, so the
  // run cannot end in a CSV with a blank topic or missing instructions.
  if (wantCsv && !CSV_SKIP.has(outDir)) {
    try {
      const meta = await askMeta(outDir, preset);
      console.log(`topic: ${meta.topic}`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // Keep the exact input list with the results, so a run stays self-describing
  // even after the source list is edited for the next one.
  if (listText !== null) {
    const copy = path.join(outDir, path.basename(listFile));
    if (path.resolve(copy) !== path.resolve(listFile)) {
      await fs.writeFile(copy, listText);
      console.log(`input list copied to ${copy}`);
    }
  }

  const summary = new Array(urls.length);

  async function processChannel(raw, index) {
    const lines = [];
    const log = (m) => lines.push(m);
    const url = videosUrl(raw);
    let id = raw.trim();
    log(`== [${index + 1}/${urls.length}] ${id}  (${url})`);
    try {
      const scraped = await scrapeWithRetry(url, 3, log);
      const { rows } = scraped;
      id = scraped.id;
      if (id !== raw.trim()) log(`  channel id: ${id}`);
      if (!rows.length) {
        throw new Error('no videos found -- check the channel id, or the page was blocked');
      }
      const avail = rows.filter((r) => r.webp).length;
      log(`  ${rows.length} videos on page, ${avail} with a preview`);

      const files = await downloadClips(rows, path.join(outDir, 'webp', id), limit, log);
      if (!files.length) {
        log('  no previews on this channel -- skipping mp4');
        return { lines, entry: { id, source: raw.trim(), videos: rows.length,
                                 avail: 0, clips: 0 } };
      }
      if (files.length < limit) log(`  note: only ${files.length} of ${limit} clips available`);

      await fs.mkdir(path.join(outDir, 'mp4'), { recursive: true });
      const score = scoreByRaw.get(raw.trim());
      const base = score ? `${id}-score-${score}` : id;
      const out = path.join(outDir, 'mp4', `${base}.mp4`);
      await buildMp4(out, files, log);
      const { size } = await fs.stat(out);
      return { lines, entry: { id, source: raw.trim(), videos: rows.length, avail,
                               clips: files.length, mp4: out, mb: (size / 1e6).toFixed(1) } };
    } catch (err) {
      log(`  ! ${id}: ${err.message}`);
      return { lines, entry: { id, source: raw.trim(), error: err.message } };
    }
  }

  console.log(`running ${Math.min(parallel, urls.length)} channel(s) at a time\n`);
  let done = 0;
  await pool(urls, parallel,
    async (raw, i) => {
      // Stagger the opening requests so a burst of identical hits does not
      // make YouTube serve the preview-less page variant.
      if (i < parallel) await sleep(i * 700);
      return processChannel(raw, i);
    },
    (i, { lines, entry }) => {
      summary[i] = entry;
      console.log(lines.join('\n') + `\n  -- done (${++done}/${urls.length})\n`);
    });

  const withWebp = summary.filter((r) => r.clips > 0);
  const withoutWebp = summary.filter((r) => !r.error && !r.clips);
  const failed = summary.filter((r) => r.error);

  const L = [];
  L.push('YouTube preview run -- ' + new Date().toISOString());
  L.push(`list: ${listFile || '(urls on command line)'}`);
  L.push(`output directory: ${outDir}/`);
  L.push(`channels processed: ${summary.length}`);
  L.push(`  with previews:    ${withWebp.length}`);
  L.push(`  without previews: ${withoutWebp.length}`);
  if (failed.length) L.push(`  errored:          ${failed.length}`);
  L.push(`sampling: every ${STRIDE}th video on the page, up to ${limit} clips`);
  L.push(`parallelism: ${parallel} channel(s) at a time`);
  if (scoreByRaw.size) L.push(`min score: ${minScore}`);
  L.push('');

  L.push('== CHANNELS WITH PREVIEWS ==');
  if (!withWebp.length) L.push('  (none)');
  for (const r of withWebp) {
    L.push(`${r.id}  clips=${r.clips}  previews=${r.avail}/${r.videos}  -> ${r.mp4} (${r.mb} MB)`);
    if (r.source !== r.id) L.push(`    source: ${r.source}`);
  }
  L.push('');

  L.push('== CHANNELS WITHOUT PREVIEWS (no mp4) ==');
  if (!withoutWebp.length) L.push('  (none)');
  for (const r of withoutWebp) {
    L.push(`${r.id}  0 previews across ${r.videos} videos`);
    if (r.source !== r.id) L.push(`    source: ${r.source}`);
  }

  if (failed.length) {
    L.push('');
    L.push('== ERRORS (could not be checked) ==');
    for (const r of failed) L.push(`${r.id}  ${r.error}`);
  }

  const text = L.join('\n') + '\n';
  const reportPath = path.join(outDir, REPORT);
  await fs.writeFile(reportPath, text);
  console.log('\n' + text);
  console.log(`report written to ${reportPath}`);

  if (wantCsv) {
    const slug = await repoSlugFromGit();
    const written = await writeCsv(outDir, slug, 'main', 'csv');
    if (written) {
      console.log(`csv written to ${written.out} (${written.rows} row(s))`);
    }
  }

  if (doUpload) {
    try {
      const status = await upload(outDir, repoUrl, summary);
      await fs.appendFile(reportPath, `\nupload: ${status}\n`);
    } catch (err) {
      // The run itself succeeded; a failed upload must not discard it.
      console.error(`\n  ! upload failed: ${err.message}`);
      await fs.appendFile(reportPath, `\nupload: FAILED -- ${err.message}\n`);
      process.exitCode = 1;
    }
  }
}
main().catch((err) => { console.error(err.message); process.exit(1); });
