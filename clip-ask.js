#!/usr/bin/env node
// Ask a local vision model a yes/no question about each animated preview clip.
//
//   node clip-ask.js --dir=test1/UCgauBHVjmcc-irYUbp0wYfw \
//     --q="Do these frames show human hands manipulating or fixing a watch?"
//
// Ollama (and most VLMs) read an animated webp as a single still, so each clip
// is split into frames with ffmpeg and the frames are sent together as one
// question. Nothing leaves the machine: the model runs at localhost:11434.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MODEL = 'qwen2.5vl:7b';
const FRAMES = 6;                 // frames sampled per clip
const HOST = 'http://127.0.0.1:11434';

const SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', enum: ['yes', 'no'] },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['answer', 'confidence', 'reason'],
};

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? `${cmd} not found` : e.message)));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd}: ${out.trim().split('\n').pop()}`))));
  });
}

// These clips are short (16-24 frames), so decode them all and pick evenly
// spaced ones. Upscaling from 320x180 costs nothing and helps the encoder.
async function framesOf(clip, tmp, n) {
  await run('ffmpeg', ['-y', '-v', 'error', '-i', clip,
                       '-vf', 'scale=640:-2', '-q:v', '3',
                       path.join(tmp, 'f%03d.jpg')]);
  const all = (await fs.readdir(tmp)).filter((f) => f.endsWith('.jpg')).sort();
  if (!all.length) throw new Error('ffmpeg produced no frames');
  const step = all.length / Math.min(n, all.length);
  const picked = [];
  for (let i = 0; picked.length < Math.min(n, all.length); i++) {
    picked.push(all[Math.min(all.length - 1, Math.floor(i * step))]);
  }
  return Promise.all(picked.map((f) => fs.readFile(path.join(tmp, f), 'base64')));
}

async function ask(question, images, model) {
  const res = await fetch(`${HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: `${question}\n\nThese frames are sampled from ONE short video clip. ` +
              `Judge the clip as a whole. Answer strictly as JSON.`,
      images,
      format: SCHEMA,
      stream: false,
      options: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  try {
    return JSON.parse(body.response);
  } catch {
    return { answer: '?', confidence: 0, reason: String(body.response).slice(0, 120) };
  }
}

async function main() {
  const arg = (n, d) => {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : d;
  };
  const dir = arg('dir');
  const question = arg('q');
  const model = arg('model', MODEL);
  const nFrames = Number(arg('frames', FRAMES));
  const limit = Number(arg('limit', 10));
  const framesOnly = process.argv.includes('--frames-only');

  if (!dir || (!question && !framesOnly)) {
    console.error('usage: node clip-ask.js --dir=DIR --q="question" [--limit=10] ' +
                  '[--frames=6] [--model=qwen2.5vl:7b] [--frames-only]');
    process.exit(1);
  }

  const clips = (await fs.readdir(dir))
    .filter((f) => /\.(webp|mp4)$/i.test(f)).sort().slice(0, limit);
  if (!clips.length) { console.error(`no clips in ${dir}`); process.exit(1); }

  console.log(`${clips.length} clip(s) from ${dir}`);
  console.log(framesOnly ? `extracting ${nFrames} frames each\n`
                         : `model: ${model}, ${nFrames} frames per clip\n`);

  const results = [];
  for (const [i, clip] of clips.entries()) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-ask-'));
    try {
      const images = await framesOf(path.join(dir, clip), tmp, nFrames);
      const label = clip.replace(/\.(webp|mp4)$/i, '').slice(0, 58);
      if (framesOnly) {
        const kb = Math.round(images.reduce((n, b) => n + b.length * 0.75, 0) / 1024);
        console.log(`  [${i + 1}] ${label}\n      ${images.length} frames, ${kb} KB`);
        continue;
      }
      const t0 = Date.now();
      const r = await ask(question, images, model);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      results.push({ clip, ...r });
      console.log(`  [${i + 1}] ${r.answer.toUpperCase().padEnd(3)} ` +
                  `(${Number(r.confidence).toFixed(2)}, ${secs}s)  ${label}`);
      console.log(`      ${r.reason}`);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  if (!framesOnly) {
    const yes = results.filter((r) => r.answer === 'yes').length;
    console.log(`\n=== ${yes} yes / ${results.length - yes} no, of ${results.length} ===`);
    await fs.writeFile('clip-ask-results.json',
      JSON.stringify({ dir, question, model, results }, null, 2) + '\n');
    console.log('written to clip-ask-results.json');
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
