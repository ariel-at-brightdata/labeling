# yt-webp.js

Downloads YouTube hover-preview clips — the short animated `.webp` loops that
play when you hover a video thumbnail — into **one folder per channel**.

Node only. No npm packages, no ffmpeg, no git, no output files other than the
clips themselves.

```bash
node yt-webp.js --file=pottery_channels --limit=10 --parallel=5
```

## Options

| flag | default | meaning |
| --- | --- | --- |
| `--file=NAME` | *required* | list to read; the `.txt`/`.csv` extension is optional |
| `--limit=N` | 6 | clips per channel |
| `--skip=N` | 1 | step between previews: `1` takes #1 #2 #3, `2` takes #1 #3 #5 |
| `--out=DIR` | the list's name | where the channel folders go; `.` for the current directory |
| `--parallel=N` | 1 | channels fetched at once |
| `--min_score=N` | off | for a CSV with a score column, skip channels below N |
| `--help` | | the same reference, in the terminal |

Hyphens and underscores are interchangeable (`--min-score` = `--min_score`), and
an unrecognised flag is an error rather than being taken for a channel name.

## Input

A `.txt` with one channel per line, or any `.csv`. Raw `UC…` ids, full URLs and
`@handles` all work and may be mixed. Header rows, blank lines and `#` comments
are ignored.

**The channel-id column is found in whatever file you have.** Header names are
matched ignoring case, spaces and underscores, so `channel_id`, `channelID`,
`CHANNELID` and `Channel ID` are all the same column; `url`, `handle`, `link`
and `channel` are accepted too. If none of those appear, the columns are
scanned and the one actually holding channel ids is used — including files with
no header row at all. The chosen column is printed:

```
using column 2 ("col_b") for channel ids
```

A `score_0_5`, `score` or `rating` column is read only if you pass
`--min_score`. Unlike `yt-previews.js`, scoring is **off by default** here:
every channel in the list is fetched unless you filter.

## Output

```
<out>/<channelId>/01_p01_<videoId>_<title>.webp
```

`01` is the clip's order, `p01` the position it was taken from on the channel's
page. Nothing else is written.

## Choosing which previews

Previews are taken consecutively by default (`#1 #2 #3 …`). `--skip=N` spreads
them across the page instead:

| flag | positions taken |
| --- | --- |
| `--skip=1` (default) | #1 #2 #3 #4 #5 #6 |
| `--skip=2` | #1 #3 #5 #7 #9 #11 |
| `--skip=3` | #1 #4 #7 #10 #13 #16 |
| `--skip=4` | #1 #5 #9 #13 #17 #21 |

If a sampled slot has no preview, the next previewed video is used instead, so
the requested number of clips is still collected where the channel has them.

## How it works

Preview URLs are signed by YouTube (`sqp` / `rs` query params) — an unsigned
`i.ytimg.com/an_webp/<id>/mqdefault_6s.webp` returns 404, so they cannot be
constructed from a video id. They are read out of the channel page's
`ytInitialData`. Only the initial HTML render of the `/videos` tab carries
them: the InnerTube `browse` API and the scroll continuations return none.

## Things worth knowing

Coverage varies a lot between channels — some expose a preview for every video,
some for a handful, some for none. A channel with none is reported and skipped;
the run continues.

YouTube intermittently serves a page variant carrying no previews at all, which
gets likelier when many channels are fetched back to back. An empty or
unparseable response is retried before the channel is written off, and parallel
runs stagger their opening requests for the same reason.

A signed URL that has expired still returns HTTP 200 with a tiny placeholder,
so every download is checked for the WebP magic bytes and an `ANIM` chunk
rather than trusting the status code.

Only the first page of a channel (~30 videos) is read. That caps both `--limit`
and how far `--skip` can reach: `--skip=4 --limit=10` would need 37 positions
and will run out, falling back to the remaining previewed videos in page order.
