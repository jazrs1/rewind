# Lite exam radar

Lists the moments in `*.transcript.json` files where the lecturer flags exam material.

```sh
node scripts/radar/scan.mjs [--speaker "<name>"] private/*.transcript.json > private/radar.json
node scripts/radar/test.mjs   # unit tests on the invented fixture
```

- Phrases and their regex variants live in `phrases.json` (`{ phrase, kind, pattern }`, matched case-insensitively). `kind` is one of `exam`, `importance`, `common-mistake`, `interview` or `recall`. The last five phrases are Professor Kapoor's own wording (T8), found in a real lecture; the quotes stay in `private/spike/emphasis-suggestions.json`. The test checks that all fifteen phrases are present and tagged.
- stdout: `[{ file, start, speaker, phrase, kind, text, context }]`. A segment matching several phrases gives one hit per phrase. `context` is every segment, from any speaker, overlapping the 20 s before through the 20 s after the hit.
- stderr: counts grouped by kind, then by phrase (including zeros), then each hit with its `m:ss` time and `[kind: phrase]`.
- `--speaker` keeps segments whose speaker contains the given text, ignoring case (`--speaker Kapoor` matches "Firstname Kapoor"). Segments with a `null` speaker are dropped when the flag is set.

## Emphasis-phrase test for John

Run it on your real transcripts in `private/`, with and without `--speaker`, and note which phrases got hits. A phrase with 0 hits on several lectures should probably be swapped for how the professor actually says it.
