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
const path = require('path');
const { spawn } = require('child_process');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PER_CHANNEL = 6;                 // clips per channel, per the spec
const STRIDE = 4;                      // sample every 4th video: #1, #5, #9, ...
const REPORT = 'report.txt';           // written at the end of every run
const CONVERTER = path.join(__dirname, 'webp2mp4-purejs.js');
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

// ----------------------------------------------------------------- converting

// Capture rather than inherit: with several conversions in flight their output
// would otherwise interleave into nonsense.
function runNode(args, log) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => {
      for (const line of out.split('\n')) if (line.trim()) log('  ' + line.trimEnd());
      code === 0 ? resolve() : reject(new Error(`webp2mp4 exited ${code}`));
    });
  });
}

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
async function upload(outDir, repoUrl, summary) {
  console.log('\n== uploading to GitHub');

  let root = await git(['rev-parse', '--show-toplevel']);
  if (root.code !== 0) {
    if (!repoUrl) {
      throw new Error('not a git repository -- pass --repo=https://github.com/<owner>/<repo>.git');
    }
    console.log('  initialising repository');
    await git(['init', '-b', 'main']);
  }

  // Identity only if the repo does not already have one.
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

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'main';

  // If the remote moved on (another machine, an edit in the web UI), rebase
  // onto it rather than failing the push.
  const fetched = await git([...tokenArgs, 'fetch', 'origin', branch]);
  if (fetched.code === 0) {
    const behind = await git(['rev-list', '--count', `HEAD..origin/${branch}`]);
    if (behind.code === 0 && Number(behind.out) > 0) {
      console.log(`  remote is ${behind.out} commit(s) ahead -- rebasing`);
      const rb = await git(['pull', '--rebase', 'origin', branch]);
      if (rb.code !== 0) throw new Error(`rebase failed, resolve by hand: ${rb.out}`);
    }
  }

  console.log('  pushing...');
  const push = await git([...tokenArgs, 'push', '-u', 'origin', branch]);
  if (push.code !== 0) {
    const denied = /could not read Username|Authentication failed|Permission denied|403/i
      .test(push.out);
    throw new Error(denied ? `${AUTH_HELP}\n\n  git said: ${push.out.split('\n')[0]}`
                           : `push failed: ${push.out}`);
  }
  const webUrl = url.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  console.log(`  pushed to ${webUrl}`);
  return `pushed to ${webUrl} (${msg})`;
}

// ----------------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const urls = [];
  let limit = PER_CHANNEL;
  let listFile = null;
  let outDir = null;
  let parallel = 1;
  let doUpload = false;
  let repoUrl = null;
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].match(/^--(file|limit|out|parallel|upload|repo)=(.*)$/);
    const [flag, value] = eq ? [eq[1], eq[2]] : [argv[i].replace(/^--/, ''), null];
    if (flag === 'file') listFile = value ?? argv[++i];
    else if (flag === 'limit') limit = Number(value ?? argv[++i]);
    else if (flag === 'out') outDir = value ?? argv[++i];
    else if (flag === 'parallel') parallel = Math.max(1, Number(value ?? argv[++i]) || 1);
    else if (flag === 'upload') doUpload = value === null ? true : !/^(false|0|no)$/i.test(value);
    else if (flag === 'repo') repoUrl = value ?? argv[++i];
    else urls.push(argv[i]);
  }

  // No URLs on the command line means: work through the channel list file.
  if (!urls.length && !listFile) listFile = DEFAULT_LIST;
  if (listFile) {
    let text;
    const candidates = [listFile, `${listFile}.txt`];
    for (const c of candidates) {
      try {
        text = await fs.readFile(c, 'utf8');
        listFile = c;
        break;
      } catch { /* try the next candidate */ }
    }
    if (text === undefined) {
      console.error(`cannot read ${candidates.join(' or ')} -- put one channel URL ` +
                    `per line in it, or pass URLs as arguments`);
      process.exit(1);
    }
    const lines = text.split(/\r?\n/).map((l) => l.trim())
                      .filter((l) => l && !l.startsWith('#'));
    const skipped = lines.filter((l) => !looksLikeChannel(l));
    urls.push(...lines.filter(looksLikeChannel));
    for (const l of skipped) console.log(`  skipping non-channel line: ${l}`);
    if (!urls.length) {
      console.error(`${listFile} has no channel URLs in it`);
      process.exit(1);
    }
    console.log(`${urls.length} channel(s) from ${listFile}`);
    if (!outDir) outDir = path.basename(listFile).replace(/\.[^.]+$/, '');
  }

  // A list file with no extension would collide with the directory named after
  // it, so step aside rather than failing on mkdir.
  if (!outDir) outDir = 'output';
  if (path.resolve(outDir) === path.resolve(listFile || '')) outDir += '-out';
  await fs.mkdir(outDir, { recursive: true });
  console.log(`output directory: ${outDir}/`);

  // Keep the exact input list with the results, so a run stays self-describing
  // even after the source list is edited for the next one.
  if (listFile) {
    const copy = path.join(outDir, path.basename(listFile));
    if (path.resolve(copy) !== path.resolve(listFile)) {
      await fs.copyFile(listFile, copy);
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
      const out = path.join(outDir, 'mp4', `${id}.mp4`);
      await runNode([CONVERTER, out, ...files], log);
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
