# Dispatch template — AGY transcriber (audio / video / YouTube)

Not an agent definition. Paste into an `agy-runner` dispatch.
Local media files: `--add-dir` for READ access to the media folder only.
Never pass paths containing secrets.

KNOWN FOOTGUNS (verified 2026-07-03):
- Video/YouTube tasks exceed the default bridge timeout — the runner must
  call the bridge with `-TimeoutSec 600`. 240s is not enough.
- YouTube "transcription" is NOT first-hand listening: AGY works from
  metadata + closed captions + community sources. CC disabled → it can only
  produce a research digest, not a transcript — AGY reports this in GAPS;
  the orchestrator must treat such output as secondary-source research.
- The CLI has NO native audio ingestion (`view_file` rejects flac/mp3/wav).
  BUT a bare "Please transcribe this file: <path>" prompt makes agy
  improvise a working pipeline itself (ffmpeg convert → 15s chunks →
  Google Web Speech API via Python SpeechRecognition). Quality verified:
  - Clean SPEECH or isolated VOCAL STEMS (Thai tested): decent, usable.
  - FULL MUSIC MIX (Japanese tested): garbage — do not bother.
- CONTAMINATION: for any known/famous song agy web-searches the official
  lyrics and presents them as "verified transcription". For a true-listening
  transcript, the dispatch MUST forbid web search / lyric lookup and demand
  raw ASR output only.
- SANDBOX LEAK: with `--add-dir <folder> -SkipPerms` agy will WRITE its
  output .txt into that folder uninvited. Read-only intent must be stated,
  and output location named explicitly (agy-out) — or accept the txt
  droppings.

Effective scope today: YouTube/online research digests (secondary-source
caveat) + local clean-speech/vocal-stem ASR via agy's improvised pipeline.

## PROVEN RECIPE — local media transcription (blind-tested 2026-07-03)

Verified result: short Thai speech clip, neutral filename, no web access →
near-perfect transcript, uncertain word honestly marked `[?]` instead of
guessed. agy self-improvised the pipeline AND did signal analysis (RMS
energy, per-segment re-transcription) to chase trailing words.

1. **Neutralize the filename first**: copy the media to a scratch folder
   under a meaningless name (e.g. `sample-a17.mp3`). Filenames leak content
   → agy pattern-matches known songs/phrases from the name alone.
2. Bridge flags: `-TimeoutSec 600 --add-dir <scratch-media-folder> -SkipPerms`
   — point `--add-dir` at the isolated scratch folder ONLY, never the real
   project folder (agy writes uninvited .txt files into whatever it gets).
3. Prompt (verbatim skeleton):

   "Please transcribe this file: <path>

   Rules: transcribe purely from the audio (likely <language> speech).
   Do NOT web-search anything. Output the raw transcription directly in
   your answer text — do not write any files. Mark uncertain words with [?]."

   Key points: keep it bare (no tool names — agy improvises better than it
   follows toolchain instructions), forbid web search (kills lyric/phrase
   contamination), demand answer-text output (kills sandbox-leak writes).
4. Expectations: clean speech / isolated vocal stems = usable transcript;
   full music mix = garbage, don't dispatch it.

---

You are AGY, this team's transcriber. Your job: transcribe the given audio,
video, or YouTube content and return it in the requested form — the
orchestrator never processes raw media itself.

Rules:
- Default output: full transcript with timestamps every ~30s and speaker
  labels where distinguishable.
- If the dispatch asks for a digest instead: KEY POINTS (bulleted, with
  timestamps) / QUOTES worth keeping verbatim / GAPS (inaudible sections,
  parts you could not access).
- Thai/English code-switching: transcribe as spoken; do not translate
  unless asked.
- Mark uncertain hearings with [?] rather than guessing silently.
- YouTube: state which video (title + channel) you actually accessed —
  wrong-video transcriptions are worse than failures.
- Long media: if the dispatch names sections/timestamps, do only those.

Report: TRANSCRIPT (or digest) / SOURCE confirmed (file or video title) /
GAPS.

---

## Orchestrator fills in
- Source (file path / YouTube URL):
- Output form (full transcript / digest / specific sections):
- Language handling (as-spoken / translate to X):
