#!/usr/bin/env node
// Download YouTube hover-preview clips into one folder per channel.
//
//   node yt-webp.js --file=pottery_channels --limit=10
//
// Reads a .txt (one channel per line) or a .csv (a channel_id, url or handle
// column), and writes <out>/<channelId>/*.webp -- nothing else. No mp4, no
// CSV, no metadata, no git.
//
// The preview URLs are signed by YouTube (sqp/rs query params); an unsigned
// i.ytimg.com/an_webp/<id>/mqdefault_6s.webp returns 404, so they have to be
// read out of the channel page's ytInitialData. Only the initial HTML render
// of the /videos tab carries them -- the InnerTube browse API and the scroll
// continuations return none.

const fs = require('fs/promises');
const path = require('path');

const PER_CHANNEL = 6;    // clips per channel unless --limit says otherwise
const SKIP = 1;           // step between previews: 1 = every one, 2 = 1,3,5...

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

// Walk the page taking every skip-th video: 1 gives #1 #2 #3, 2 gives #1 #3 #5.
// A sampled slot whose video has no preview would otherwise cost us a clip, so
// fall through to the next previewed video after it and carry on from there.
function sample(rows, limit, skip = SKIP) {
  const picked = [];
  const used = new Set();
  for (let i = 0; i < rows.length && picked.length < limit; i += skip) {
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

// ------------------------------------------------------------- list handling

// Read a .txt or .csv list. A CSV is taken from its channel_id column (or url,
// or handle); a score column is used only by --min_score.
function readList(text, filename) {
  text = text.replace(/^\uFEFF/, '');              // strip a spreadsheet BOM
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

// The extension is optional: --file=pottery finds pottery.csv or pottery.txt.
async function readListFile(name) {
  for (const candidate of [name, `${name}.csv`, `${name}.txt`]) {
    try {
      return { text: await fs.readFile(candidate, 'utf8'), path: candidate };
    } catch { /* next candidate */ }
  }
  throw new Error(`cannot read ${name}, ${name}.csv or ${name}.txt`);
}

// ---------------------------------------------------------------- downloading

async function fetchChannel(raw, limit, outRoot, log, skip) {
  const url = videosUrl(raw);
  const { id, rows } = await scrapeWithRetry(url, 3, log);
  if (!rows.length) throw new Error('no videos found -- check the id, or the page was blocked');

  const withPreview = rows.filter((r) => r.webp).length;
  const picked = sample(rows, limit, skip);
  if (!picked.length) {
    log(`  no previews on this channel`);
    return { id, videos: rows.length, withPreview, saved: 0 };
  }
  log(`  ${rows.length} videos, ${withPreview} with a preview; taking ` +
      picked.map((p) => '#' + p.position).join(' '));

  const dir = path.join(outRoot, id);
  await fs.mkdir(dir, { recursive: true });

  let saved = 0;
  for (const row of picked) {
    let buf;
    try {
      buf = await get(row.webp, false);
    } catch (err) {
      log(`  ! ${row.videoId}: ${err.message}`);
      continue;
    }
    // An expired signature still returns 200 with a tiny placeholder, so check
    // the magic bytes rather than trusting the status.
    if (!isAnimatedWebp(buf)) {
      log(`  ! ${row.videoId}: not an animated webp (${buf.length} bytes)`);
      continue;
    }
    const n = ++saved;
    const name = `${String(n).padStart(2, '0')}_p${String(row.position).padStart(2, '0')}` +
                 `_${row.videoId}_${slug(row.title)}.webp`;
    await fs.writeFile(path.join(dir, name), buf);
    log(`  [${n}/${limit}] ${name} (${Math.round(buf.length / 1024)} KB)`);
    await sleep(400);
  }
  return { id, videos: rows.length, withPreview, saved, dir };
}

// ----------------------------------------------------------------------- main

const HELP = `yt-webp.js -- download YouTube hover-preview clips, one folder per channel

USAGE
  node yt-webp.js --file=NAME [options]

OPTIONS
  --file=NAME      list to read; the .txt/.csv extension is optional
  --limit=N        clips per channel (default ${PER_CHANNEL})
  --out=DIR        where the channel folders go (default: the list's name)
  --parallel=N     channels fetched at once (default 1)
  --min_score=N    for a CSV with a score_0_5 column, skip channels below N
                   (default: off, every channel in the list is used)
  --skip=N         step between previews: 1 takes #1 #2 #3, 2 takes #1 #3 #5
                   (default ${SKIP})
  --help           this text

INPUT
  A .txt with one channel per line, or any .csv. Raw UC ids, full URLs and
  @handles all work and may be mixed; header rows, blank lines and #comments
  are ignored.

  The channel id column is matched ignoring case, spaces and underscores, so
  channel_id, channelID, CHANNELID and "Channel ID" are all the same column;
  url, handle, link and channel work too. If none of those appear, the columns
  are scanned and the one holding channel ids is used -- including files with
  no header row. See yt-webp.md for the full reference.

OUTPUT
  <out>/<channelId>/01_p01_<videoId>_<title>.webp

  The pNN part is the position the clip was taken from on the channel page.

  Nothing else is written: no mp4, no CSV, no metadata, no git.

EXAMPLES
  Six clips from every channel in a list:
    node yt-webp.js --file=pottery_channels

  Ten clips each, five channels at a time:
    node yt-webp.js --file=pottery_channels --limit=10 --parallel=5

  Only the channels scored 4 or 5, into a folder of your choosing:
    node yt-webp.js --file=pottery_channels --min_score=4 --out=pottery_webp

  Channel folders directly in the current directory:
    node yt-webp.js --file=hands1 --out=.

  Every other preview -- #1, #3, #5 ... -- to spread them across the page:
    node yt-webp.js --file=pottery_channels --skip=2

NOTES
  Coverage varies: some channels expose a preview for every video, some for a
  handful, some for none. A channel with none is reported and skipped.
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.some((a) => /^--h(elp)?$/.test(a.replace(/-/g, '-'))) || argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  const KNOWN = ['file', 'limit', 'out', 'parallel', 'min_score', 'skip', 'help'];
  const die = (m) => { console.error(m); process.exit(1); };
  const num = (raw, flag) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) die(`--${flag} needs a number, got "${raw}"`);
    return n;
  };

  let listName = null, limit = PER_CHANNEL, outRoot = null;
  let parallel = 1, minScore = null, skip = SKIP;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) die(`unexpected argument: ${a}\nrun with --help for usage`);
    const m = a.match(/^--([A-Za-z][\w-]*)(?:=([\s\S]*))?$/);
    if (!m) die(`unrecognised argument: ${a}`);
    // Hyphens and underscores are interchangeable in flag names.
    const flag = m[1].replace(/-/g, '_').toLowerCase();
    const value = m[2] ?? null;

    if (flag === 'file') listName = value ?? argv[++i];
    else if (flag === 'limit') limit = num(value ?? argv[++i], 'limit');
    else if (flag === 'out') outRoot = value ?? argv[++i];
    else if (flag === 'parallel') parallel = Math.max(1, num(value ?? argv[++i], 'parallel'));
    else if (flag === 'min_score') minScore = num(value ?? argv[++i], 'min_score');
    // --stride is kept as an alias: both mean the step between previews.
    else if (flag === 'skip' || flag === 'stride') {
      skip = Math.max(1, num(value ?? argv[++i], flag));
    }
    else if (flag === 'help') { console.log(HELP); return; }
    else die(`unknown option --${m[1]}\nvalid options: ${KNOWN.map((k) => '--' + k).join(', ')}`);
  }

  if (!listName) die('--file=NAME is required (run with --help for usage)');

  let list;
  try {
    list = await readListFile(listName);
  } catch (err) {
    die(err.message);
  }

  let parsed;
  try {
    parsed = readList(list.text, list.path);
  } catch (err) {
    die(err.message);
  }

  const channels = [];
  let belowCutoff = 0;
  for (const e of parsed.entries) {
    if (minScore !== null && e.score !== '' && Number(e.score) < minScore) {
      belowCutoff++;
      continue;
    }
    channels.push(e.raw);
  }
  for (const l of parsed.skipped) console.log(`  skipping non-channel line: ${l}`);
  if (belowCutoff) console.log(`  ${belowCutoff} channel(s) below --min_score=${minScore}, skipped`);
  if (!channels.length) die(`no channels to fetch from ${list.path}`);

  if (!outRoot) outRoot = path.basename(list.path).replace(/\.[^.]+$/, '');
  await fs.mkdir(outRoot, { recursive: true });
  console.log(`${channels.length} channel(s) from ${list.path}`);
  console.log(`output directory: ${outRoot}/`);
  console.log(`${Math.min(parallel, channels.length)} at a time, ${limit} clip(s) each\n`);

  const results = new Array(channels.length);
  let done = 0;

  await pool(channels, parallel,
    async (raw, i) => {
      // Stagger the opening requests: a burst of identical hits makes YouTube
      // serve the page variant that carries no previews at all.
      if (i < parallel) await sleep(i * 700);
      const lines = [];
      const log = (m) => lines.push(m);
      log(`== [${i + 1}/${channels.length}] ${raw.trim()}`);
      try {
        const r = await fetchChannel(raw, limit, outRoot, log, skip);
        return { lines, result: r };
      } catch (err) {
        log(`  ! ${err.message}`);
        return { lines, result: { id: raw.trim(), saved: 0, error: err.message } };
      }
    },
    (i, { lines, result }) => {
      results[i] = result;
      console.log(lines.join('\n') + `\n  -- done (${++done}/${channels.length})\n`);
    });

  const ok = results.filter((r) => r.saved > 0);
  const empty = results.filter((r) => !r.error && !r.saved);
  const failed = results.filter((r) => r.error);
  const clips = ok.reduce((n, r) => n + r.saved, 0);

  console.log('=== summary ===');
  console.log(`channels: ${results.length}`);
  console.log(`  with clips:    ${ok.length}  (${clips} webp files in ${outRoot}/)`);
  console.log(`  no previews:   ${empty.length}`);
  if (failed.length) console.log(`  errored:       ${failed.length}`);
  for (const r of failed) console.log(`    ! ${r.id}: ${r.error}`);
  for (const r of ok.filter((x) => x.saved < limit)) {
    console.log(`    note: ${r.id} had only ${r.saved} of ${limit}`);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
