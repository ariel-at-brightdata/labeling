# labeling

Downloads YouTube hover-preview animations (the short `.webp` loops that play
when you hover a video thumbnail) for a list of channels, and stitches six of
them per channel into a single MP4 with numbered title cards.

## Usage

```bash
node yt-previews.js                          # reads ./channels.txt
node yt-previews.js --file="talking heads"   # reads that list (.txt optional)
node yt-previews.js --file=hands1 --parallel=5
node yt-previews.js https://www.youtube.com/@handle   # ad-hoc, no list file
```

Flags:

| flag | default | meaning |
| --- | --- | --- |
| `--file=NAME` | `channels.txt` | channel list to read; `.txt` optional |
| `--parallel=N` | `1` | channels processed concurrently |
| `--limit=N` | `6` | clips per channel |
| `--out=DIR` | list name | override the output directory |
| `--upload=true` | off | commit the run and push it to GitHub |
| `--repo=URL` | existing `origin` | set the remote (only needed once) |
| `--min_score=N` | `5` | for scored CSV lists, skip channels below N |
| `--csv=false` | on | skip writing the labelling CSV |
| `--csv-only` | | rebuild every CSV from the mp4s on disk, then exit |
| `--help` | | usage and worked examples |

## Input

A `.txt` with one channel per line, or a `.csv`. Raw IDs, full URLs and
`@handles` are all accepted, and may be mixed. A header row (e.g.
`CHANNEL_URL`), blank lines and `#` comments are skipped.

```
CHANNEL_URL
https://www.youtube.com/channel/UC-No2ITxJsNt50oJQ3fLmUA
UC0HOUqH0Sb9pYcxOWxdh6-w
@somehandle
```

A CSV list is read from its `channel_id` column (falling back to `url` or
`handle`), quoted fields and a spreadsheet BOM included. If it also has a
`score_0_5` column, the score is appended to the MP4 filename
(`<channelId>-score-<n>.mp4`) and `--min_score` filters the run — the default
of 5 keeps only top-scored channels. Lists without scores ignore the cutoff.

## Output

Each list gets its own directory, named after the list file, so separate runs
never overwrite each other:

```
<list name>/
  <list name>.txt          copy of the input list used for the run
  report.txt               which channels had previews and which did not
  mp4/<channelId>.mp4      one video per channel
  webp/<channelId>/        the source clips + manifest.json
```

Files are named by the canonical `UC…` channel ID, whatever form the input
took. Clip filenames record the page position they were sampled from
(`01_p01_…`, `02_p05_…`).

## Uploading

`--upload=true` commits everything in the working tree and pushes it to
`origin`. The first time, point it at the repository:

```bash
node yt-previews.js --file=hands1 --parallel=5 --upload=true \
  --repo=https://github.com/<owner>/<repo>.git
```

After that `--upload=true` is enough — the remote is remembered in
`.git/config`. It initialises the repository if there is not one yet, and if
the remote has moved on it rebases onto it rather than failing or clobbering.
A failed upload never discards the run: the clips and report are already on
disk, the commit is made locally, and the next successful push carries it.

Authentication is whatever git already has — `gh auth login`, an SSH key, or
`GITHUB_TOKEN` in the environment (sent as a one-off header, never written to
`.git/config` or into a commit). Terminal prompts are disabled, so a missing
credential fails immediately with instructions instead of hanging.

## How it works

Preview URLs are signed by YouTube (`sqp` / `rs` query params) — an unsigned
`i.ytimg.com/an_webp/<id>/mqdefault_6s.webp` returns 404, so they cannot be
constructed from a video ID. They are read out of the channel page's
`ytInitialData`. Only the initial HTML render of the `/videos` tab carries
them: the InnerTube `browse` API and scroll continuations return none.

Videos are sampled every 4th position on the page (`#1 #5 #9 #13 #17 #21`). If
a sampled slot has no preview, the next previewed video is used instead.

Not every channel exposes previews, and coverage varies widely — some channels
have 30 of 30, others 6 of 30, some none at all. A channel with none is
recorded in `report.txt` and skipped rather than failing the run. YouTube also
intermittently serves a page variant with no previews at all, so an empty or
unparseable response is retried before the channel is written off.

## Requirements

`yt-previews.js` is self-contained: it needs node (no npm packages) and
ffmpeg 7.1+ / ffprobe, nothing else. The animated-WebP conversion and the
labelling-CSV generation are built in; `webp2mp4-purejs.js` remains only as a
standalone converter and is no longer used by the pipeline.

ffmpeg 7.1 is the version — 7.1 is where ffmpeg gained
its native animated-WebP decoder; older builds silently see only the first
frame.
