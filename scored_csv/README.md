# scored_csv

Scored channel lists — the CSVs used as input to `yt-previews.js`.

A file here is read from its `channel_id` column (falling back to `url` or
`handle`). If it also has a `score_0_5` column, the score is appended to each
MP4 filename (`<channelId>-score-<n>.mp4`) and `--min_score` decides which
channels are processed:

```bash
node yt-previews.js --file=scored_csv/pottery_channels.csv --min_score=4 --parallel=5
```
