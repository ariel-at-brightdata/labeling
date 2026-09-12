#!/usr/bin/env node
// Build one labelling CSV per channel list, pointing at the MP4s on GitHub.
//
//   node make-csv.js [--repo=owner/name] [--branch=main] [--out=csv]
//
// For every <topic>.txt that has a matching <topic>/mp4/ directory, writes
// csv/<topic>.csv with one row per MP4. Column layout follows the template:
//
//   topic,description,video_url,Instructions,user1 decision,...
//
// Only topic, description and video_url are filled; the rest are left empty
// for the labellers.

const fs = require('fs');
const path = require('path');

// Shared opening for every labelled topic, then the per-topic criterion.
// A topic with no entry here gets an empty Instructions column; a topic in
// SKIP gets no CSV at all.
const PREAMBLE =
  'You will see a few short previews of video from a certain category. ' +
  'It should give a general idea of the contents of videos. Use your judgment ' +
  'to decide if the total impression of the video you saw fits the category. ' +
  'It does not have to be 100%. If you are not sure, say no.';

const CRITERIA = {
  hands1: 'We need to see human hands manipulating something in most of the ' +
          'video. For example, sculpting or writing. It is okay to have brief ' +
          'parts where hands are not visible.',
  talkingheads: 'We need to see one or more people talking in most of the ' +
                'video, like sitting for a podcast or an interview. It is OK ' +
                'to have brief parts where a slide or video is shown.',
};

const SKIP = new Set(['channels']);

const instructionsFor = (topic) =>
  CRITERIA[topic] ? `${PREAMBLE} ${CRITERIA[topic]}` : '';

const COLUMNS = ['topic', 'description', 'video_url', 'Instructions',
                 'user1 decision', 'user1 decision date', 'user2',
                 'user3 decision date', 'user3', 'user3 decision date',
                 'demo_video'];

// Worked examples for the labellers: the first two videos of each topic are
// marked as bad, the next two as good. Everything after that is left blank.
const DEMO_MARKS = ['bad', 'bad', 'good', 'good'];

const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const repo = arg('repo', 'ariel-at-brightdata/labeling');
const branch = arg('branch', 'main');
const outDir = arg('out', 'csv');

// Quote only when a field needs it, so the output diffs cleanly.
const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const row = (values) => COLUMNS.map((c) => cell(values[c] ?? '')).join(',');

function rawUrl(file) {
  const encoded = file.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${repo}/${branch}/${encoded}`;
}

fs.mkdirSync(outDir, { recursive: true });

const topics = fs.readdirSync('.')
  .filter((f) => f.endsWith('.txt'))
  .map((f) => f.replace(/\.txt$/, ''))
  .filter((t) => !SKIP.has(t) && fs.existsSync(path.join(t, 'mp4')))
  .sort();

if (!topics.length) {
  console.error('no <topic>.txt with a matching <topic>/mp4/ directory found');
  process.exit(1);
}

let total = 0;
for (const topic of topics) {
  const mp4s = fs.readdirSync(path.join(topic, 'mp4'))
                 .filter((f) => f.endsWith('.mp4'))
                 .sort();
  const lines = [COLUMNS.join(',')];
  mp4s.forEach((file, i) => {
    lines.push(row({
      topic,
      description: `videos of ${topic}`,
      video_url: rawUrl(`${topic}/mp4/${file}`),
      Instructions: instructionsFor(topic),
      demo_video: DEMO_MARKS[i] ?? '',
    }));
  });
  const out = path.join(outDir, `${topic}.csv`);
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`${out}  ${mp4s.length} video(s)` +
              (instructionsFor(topic) ? '  [instructions set]' : '  [no instructions]'));
  total += mp4s.length;
}
console.log(`\n${topics.length} csv file(s), ${total} video url(s)`);
