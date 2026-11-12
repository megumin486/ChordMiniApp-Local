# ChordMini — Local Edition

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20.9-brightgreen.svg)
![Python](https://img.shields.io/badge/python-3.9--3.11-blue.svg)
![Next.js](https://img.shields.io/badge/Next.js-16-black.svg)
![Flask](https://img.shields.io/badge/Flask-API-lightgrey.svg)

ChordMini is a music analysis web app: upload an audio file and it recognizes chords, tracks beats, detects key and modulation changes, and turns the result into a chord grid, Roman numeral analysis, guitar diagrams, a piano roll with MIDI export, local lyric sheets and an offline AI prompt export.

This repository is a local-only fork of [ptnghia-j/ChordMiniApp](https://github.com/ptnghia-j/ChordMiniApp). The recognition pipeline, the model weights and the interface come from the original project; the parts that depended on an account or a hosted service have been removed. Configuration is two local URLs — see [Configuration](#configuration).

Analysis, caching, harmony and prompt export all run in the process. Audio is the exception: chord playback and the in-app mini-games stream instrument samples from `gleitz.github.io` and `goldst.dev` while a sound plays, so those sounds need a network connection the first time. Everything else works offline. Dependencies and model weights are downloaded during installation, not at runtime.

Lyrics come from tags already inside the audio file you upload (ID3v2 `USLT`/`SYLT`, MP4 `©lyr`, FLAC/OGG Vorbis comments) or from a `.lrc`, `.srt`, `.txt` or `.yaml` file you pick next to the audio. The app does not fetch lyrics from a service and does not translate them.

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
  - [Quick start](#quick-start)
  - [Manual installation](#manual-installation)
- [Usage](#usage)
- [Optional: melody transcription](#optional-melody-transcription)
- [Configuration](#configuration)
- [Local data, cache & privacy](#local-data-cache--privacy)
- [Architecture & API](#architecture--api)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Differences from upstream](#differences-from-upstream)
- [Contributing](#contributing)
- [License](#license)
- [Citation](#citation)
- [Acknowledgements](#acknowledgements)

## Features

### Chord and beat analysis

![Chord grid](public/beatchord_grid.png)

Synchronized chord recognition and beat tracking displayed as a grid, with Roman numeral analysis, simplified chord notation and manual chord corrections.

### Guitar diagrams

![Guitar diagrams](public/guitar_diagrams.png)

Interactive fingerings from the [chords-db](https://github.com/tombatossals/chords-db) database: several positions per chord, slash-chord inversions where the database has a shape for them, and a view synced to beat playback.

### Piano visualizer and MIDI export

![Piano visualizer](public/piano_visualizer.png)

A piano roll with falling notes synchronized to chord playback, a scrolling chord strip, interactive keys, and MIDI export for any DAW.

### Local lyric sheets

![Lyrics with chord grid](public/beatchord_grid_lyrics.png)

Lyrics appear on the **Lyrics & Chords** tab and, once loaded, are laid into the chord grid rows automatically. They are read from ID3v2 `USLT`/`SYLT` tags, MP4 `©lyr`, or FLAC/OGG Vorbis comments in the audio you upload, or from a lyric file you pick next to the audio picker.

### Offline AI prompt export

The hosted AI assistant of the original app is replaced by an export: the analysis is packed into a structured prompt (three timeline-precision levels — section, measure, beat — × three templates, plus guardrail instructions) that you copy into whichever LLM you already use.

### Optional melody transcription

![Melody](public/melody.png)
![Sheet music](public/sheet.png)

With the optional Sheet Sage service running, an estimated melodic line can be added on top of the piano visualizer, with its own playback, caching and MIDI export. This is experimental — inference is slower than the beat/chord pipeline — and it needs the extra service described [below](#optional-melody-transcription).

### Homepage and recent analyses

![Homepage light](public/homepage.png)
![Homepage dark](public/homepage_dark.png)

Analyses of files you have already processed are served from the local cache, so re-opening one does not re-run the analysis.

## Requirements

| | |
| --- | --- |
| **Operating system** | Linux or macOS. **On Windows use WSL2/Ubuntu** — a native Windows install is not reliable, because `spleeter` and `madmom` pull in conflicting dependencies. |
| **Node.js** | 20.9 or newer, with npm 10 or newer |
| **Python** | 3.9 – 3.11 (3.10 recommended); the launcher picks whichever is available |
| **Git** | any recent version |
| **Disk space** | plan for ~13–15 GB free. Measured on a working install: Python environment ≈7.6 GB (the bulk — PyTorch and TensorFlow), frontend packages ≈1 GB, model weights ≈190 MB, production build cache ≈3.6 GB |
| **GPU** | not required — everything runs on the CPU |

Optional: **Git LFS** if you also want the SongFormer checkpoints (skipped by default — without it the three checkpoint files are 134-byte LFS pointers, and nothing else reads them), **Docker** for the melody service.

## Installation

### Quick start

```bash
git clone --recurse-submodules https://github.com/megumin486/ChordMiniApp-Local.git
cd ChordMiniApp-Local
./start.sh --prod
```

Open **<http://127.0.0.1:3000>**. `Ctrl+C` stops the frontend and the backend together.

The first run takes five to fifteen minutes depending on your connection — the submodule download alone was about ten minutes on a slow line — and does all of the following:

1. creates `.env.local` from `.env.example` (the defaults are correct for a local run),
2. downloads the three model submodules (~190 MB in total),
3. creates `python_backend/.venv` and installs the backend requirements, falling back to the `spleeter`-free set if the full install fails (the fallback only drops 5-stem separation; beat and chord analysis are unaffected),
4. installs the frontend packages (`npm ci`),
5. starts the Flask backend on `5001` and waits for `/health`, then builds the frontend and serves it on `3000` (`--prod`), or starts the dev server instead.

Runtime logs are written to `/tmp/chordmini-backend.log` and `/tmp/chordmini-frontend.log`. If a port is already taken the launcher stops instead of starting a second copy — it never kills processes it did not start.

**Use `--prod` day to day.** It builds once and serves the prebuilt app, so pages appear immediately. The build is reused on later runs as long as the sources are unchanged — a restart then takes a few seconds instead of a full build. Pass `--rebuild` to force a fresh build, or `--no-build` to never compile (it fails if no build exists yet). Plain `./start.sh` starts the development server instead: faster to start, but each page is compiled on first visit and may take several seconds.

| Command | What it does |
| --- | --- |
| `./start.sh --prod` | build once, then serve in production mode — **recommended** (reuses the build when sources are unchanged) |
| `./start.sh --prod --rebuild` | force a fresh production build |
| `./start.sh --prod --no-build` | never compile: start on the existing build, fail if there is none |
| `./start.sh` | development server (on-demand compilation, hot reload) |
| `./start.sh --check` | report only: toolchain, virtualenv, dependencies, submodules, ports |
| `./start.sh --setup-only` | prepare everything, start nothing |
| `./start.sh --lfs` | also fetch the SongFormer Git LFS checkpoints |
| `./start.sh --no-backend` / `--no-frontend` | start only one side |
| `BACKEND_PORT=… FRONTEND_PORT=… ./start.sh` | run on different ports |

On Windows, `start.cmd` does the same from a double click: it opens WSL, runs `./start.sh --prod` in the project directory, and opens `http://127.0.0.1:3000` in your browser as soon as the frontend answers. Closing the window stops both services. The launcher is not tied to a particular distribution or path: it uses your default WSL distribution and maps its own folder into WSL, so a clone on a Windows drive and a clone inside the WSL file system both work. If your project is not where the file sits, or you want another distribution, set `CHORDMINI_WSL_DIR` / `CHORDMINI_WSL_DISTRO`; `CHORDMINI_PORT` changes the port, `NO_BROWSER=1` skips the browser, and any arguments are forwarded to `start.sh` (`start.cmd --check`, `start.cmd --prod --rebuild`).

### Manual installation

<details>
<summary>Install and run both services by hand</summary>

1. **Clone and configure**

   ```bash
   git clone --recurse-submodules https://github.com/megumin486/ChordMiniApp-Local.git
   cd ChordMiniApp-Local
   cp .env.example .env.local
   ```

   Git may mention `python_backend/beat_transformer_minimal/Beat-Transformer`: that is a legacy submodule entry with no content in this repository. The three that matter are `python_backend/models/Beat-Transformer`, `Chord-CNN-LSTM` and `ChordMini`.

2. **Backend** — terminal 1

   ```bash
   cd python_backend
   python3.10 -m venv .venv
   .venv/bin/pip install --upgrade pip setuptools wheel
   .venv/bin/pip install "Cython>=0.29.0" numpy==1.26.4
   .venv/bin/pip install git+https://github.com/CPJKU/madmom
   .venv/bin/pip install -r requirements.txt
   .venv/bin/python app.py
   ```

   If `pip install -r requirements.txt` fails on `spleeter`, install everything else:

   ```bash
   grep -v '^spleeter==' requirements.txt | grep -v '^typer==' > /tmp/requirements_nospleeter.txt
   .venv/bin/pip install --no-cache-dir -r /tmp/requirements_nospleeter.txt
   ```

3. **Frontend** — terminal 2

   ```bash
   npm ci
   npm run dev                 # development
   # or
   npm run build && npm start  # production mode
   ```

4. **Open** <http://127.0.0.1:3000>.

</details>

## Usage

1. Open <http://127.0.0.1:3000> in your browser (stay on `127.0.0.1`: the example config uses it, and in development mode the dev server only trusts that host — see Troubleshooting).
2. Pick an audio file with **Choose Audio File** — the picker accepts `audio/*`; the backend store takes MP3, WAV, FLAC, M4A, OPUS, OGG, AIFF/AIF and WebM, normalizing unknown extensions to `.mp3`. Optionally pick a `.lrc` / `.srt` / `.txt` / `.yaml` file with **Choose Lyrics File**, or rely on lyric tags already embedded in the audio.
3. Press **Analyze Audio** and wait for the analysis to finish. A file you have analyzed before returns from the local cache without re-running the analysis.
4. Explore the result tabs:

   | Tab | Content |
   | --- | --- |
   | **Beat & Chord Map** | Chord grid over the beat timeline, with the local lyric rows layered in when lyrics are loaded |
   | **Guitar** | Chord diagrams synchronized to playback |
   | **Piano** | Piano roll, scrolling chord strip and MIDI export |
   | **Lyrics & Chords** | Full lyric sheet with chord playback |

   Playback controls, key signature, Roman numerals and chord simplification are available on these tabs. The floating **Song Lyrics** panel opens from the lyrics button in the top bar and follows the playhead; its search box filters the lyrics you already loaded instead of querying a service. The upload page also shows a local cache panel where individual entries or the whole cache can be deleted.

**Ports.** Frontend `3000`, backend `5001`, optional melody service `8082`. The backend uses `5001` rather than `5000`, which macOS reserves for AirPlay.

**Health check.**

```bash
curl http://127.0.0.1:5001/health
# {"status": "healthy"}
```

## Optional: melody transcription

Sheet Sage is not bundled; build and run it as its own service:

```bash
cd sheetsage
mkdir -p cache          # the image copies cache/ into the build, and cache/ is gitignored, so create it first
docker build --platform=linux/amd64 -t sheetsage-backend:local .
docker run --rm --platform=linux/amd64 -p 8082:8082 -v "$(pwd)/cache:/app/cache" sheetsage-backend:local
```

Then point the frontend at it with `SHEETSAGE_API_URL=http://localhost:8082` in `.env.local` (`./start.sh --prod` exports this for you). Without the service the melody toggle reports itself as unavailable; the rest of the app is unaffected. See [sheetsage/README.md](sheetsage/README.md).

## Configuration

**Frontend — `.env.local`** (created from `.env.example`; those two values are all it needs. The optional lines below are not in the example — uncomment or add them by hand):

```bash
PYTHON_API_URL=http://127.0.0.1:5001        # Flask backend, used by the app's own server routes
NEXT_PUBLIC_BASE_URL=http://127.0.0.1:3000  # origin used for the app's absolute links
# SHEETSAGE_API_URL=http://localhost:8082   # optional, see the melody section
# CHORDMINI_DEBUG_DIR=/tmp                  # optional, writes JSONL debug logs
```

**Backend — environment variables** (all optional, e.g. in `python_backend/.env`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHORDMINI_DATA_DIR` | `python_backend/data` | directory holding the cache database and audio store |
| `CHORDMINI_CACHE_DB` | `<data>/chordmini_cache.db` | SQLite cache file |
| `CHORDMINI_AUDIO_DIR` | `<data>/audio` | content-addressed audio store |
| `CHORDMINI_AUDIO_MAX_MB` | `2048` | storage budget for cached audio (least-recently-used is evicted first) |
| `CHORDMINI_CACHE_TTL_DAYS` | `30` | retention for analyses and audio |
| `CHORDMINI_KV_TTL_DAYS` | `0` | key/value cache lifetime; `0` means never expire |
| `FLASK_MAX_CONTENT_LENGTH_MB` | `150` | largest upload the backend accepts |
| `CORS_ORIGINS` | six local, docker and vercel origins including `http://127.0.0.1:3000` and `http://localhost:3000` | extra origins to allow; **appended** to the built-in list, not a replacement |
| `PORT` | `5001` | backend port |
| `CHORDMINI_DEVICE` | `cpu` | compute device for the models the backend loads itself: `cpu`, `auto` (CUDA, then MPS, then CPU), `cuda`, `cuda:N` or `mps`. An unavailable or mistyped value falls back to CPU with one warning |

### GPU (optional, off by default)

A fresh clone runs on the CPU, which is what `start.sh` and the screenshots assume. A supported GPU can be selected by setting `CHORDMINI_DEVICE` in the environment that starts the backend; the launcher passes it through.

```bash
CHORDMINI_DEVICE=auto ./start.sh --prod
```

This needs a CUDA build of PyTorch and a card that build has kernels for; otherwise the backend prints one `[device]` line and keeps going on CPU. That second condition is easy to miss: a driver can enumerate a GPU that torch cannot actually execute on — for example an RTX 50-series (Blackwell, `sm_120`) card with a torch build that stops at `sm_90`. `auto` and `cuda` probe the card with a one-element kernel before committing, so they fall back to CPU instead of failing mid-analysis. `cuda` or `cuda:1` selects a specific card, `mps` is for Apple Silicon, and `cpu` (the default) is accepted explicitly too. Choosing a CUDA device also stops the backend from exporting `CUDA_VISIBLE_DEVICES=-1` — the CPU-only lock it used to apply to Spleeter and TensorFlow unconditionally, which is why the setting could not take effect before. The BTC chord models load through the `ChordMini` submodule, which already picks CUDA on its own when torch can see a GPU — so the chord path may use the card while the Beat Transformer stays on CPU until you set this variable.

## Local data, cache & privacy

Analysis data lives in a single directory inside the backend (the launcher also ensures `public/audio` and `python_backend/templates` exist; runtime logs go to `/tmp`, and UI preferences live in browser storage):

```
python_backend/data/
├── chordmini_cache.db                  # SQLite: kv_cache, audio_files, analyses
└── audio/<first 2 hex>/<sha256><ext>   # uploaded audio, content-addressed
```

- The same audio uploaded twice is stored once and its analysis is reused.
- The audio store is capped at 2048 MB and evicts least-recently-used files first; analyses and audio expire after 30 days.
- The cache is checked and cleaned when the backend starts, and the upload page has a panel to clear everything or delete a single entry.
- `rm -rf python_backend/data` resets the app to a clean state.

## Architecture & API

A Next.js app (`src/`, port 3000) serves the interface and its own small API layer for local cache access; it calls a Flask backend (`python_backend/`, port 5001) for the audio analysis itself. Model weights live in the repository as submodules and run on the CPU.

Selected backend endpoints:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/detect-beats` | Beat tracking (Beat-Transformer, madmom) |
| `POST` | `/api/recognize-chords` | Chord recognition (Chord-CNN-LSTM, BTC-SL, BTC-PL) |
| `POST` | `/api/analyze-harmony` | Roman numerals, key and modulation analysis (local rule engine, version 5) |
| `GET` | `/api/analyze-harmony/info` | Engine version and capabilities |
| `GET` | `/api/model-info` | Available beat and chord models |
| `GET` | `/health` | Health check |
| `GET` | `/api/docs`, `/docs` | Self-describing API summary |
| `GET` | `/api/cache/stats`, `/api/cache/recent` | Cache statistics and recent entries |
| `POST` | `/api/cache/clear` | Clear the cache |
| `POST` | `/api/audio/store` | Store audio in the content-addressed store |
| `GET`, `DELETE` | `/api/audio/<audio_id>` | Fetch or delete one stored audio entry |

Upstream's cloud-only routes — the `-firebase` beat and chord endpoints, YouTube search, and the YouTube/audio blueprints — were removed in this fork; the table above is everything the backend registers.

## Project structure

```
ChordMiniApp-Local/
├── start.sh                  # one-command launcher (setup, build, run, stop)
├── src/                      # Next.js frontend and its local API routes
├── python_backend/           # Flask API, models, local cache
│   ├── app.py
│   ├── blueprints/           # beats, chords, harmony, cache, health, docs, songformer, debug (+ empty youtube/audio shells kept for compatibility)
│   ├── models/               # Beat-Transformer, Chord-CNN-LSTM, ChordMini (submodules)
│   ├── services/
│   ├── data/                 # created on first run (SQLite cache + audio store)
│   └── requirements.txt
├── sheetsage/                # optional melody service, with its own README
├── SongFormer/               # segmentation model; code kept, UI entry disabled
├── public/                   # static assets and screenshots
├── __tests__/                # Jest suite
├── config/, docker/, scripts/
├── .env.example              # copied to .env.local on first run
└── package.json
```

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `port 5001 is already in use` (or 3000) | Something else is listening there. Stop it, or run `BACKEND_PORT=5002 FRONTEND_PORT=3001 ./start.sh` and update `.env.local` to match. |
| Blank or unstyled page (development mode) | `next dev` only trusts `127.0.0.1` (`allowedDevOrigins` in `next.config.js`), so open `http://127.0.0.1:3000`; the production build is not affected. |
| Development mode feels slow | That is `next dev`: every page compiles on first visit. Use `./start.sh --prod`. |
| The build is killed or takes very long | It needs roughly 4 GB of free memory; `--prod` already sets `NODE_OPTIONS=--max-old-space-size=4096`. Close other heavy applications. |
| `Failed to fetch` / `Network Error` in the browser | The backend is not running. `curl http://127.0.0.1:5001/health` should answer `{"status": "healthy"}`. |
| The melody toggle is greyed out | Expected without the Sheet Sage service — see [Optional: melody transcription](#optional-melody-transcription). |
| A Python import fails | Activate the environment (`cd python_backend && source .venv/bin/activate`) and reinstall `-r requirements.txt`. |
| Chord playback or mini-game sounds are silent | Both play instrument samples fetched from `gleitz.github.io` / `goldst.dev`; on a machine with no internet access those sounds stay silent. Everything else keeps working. |
| Git complained about a submodule while cloning | The legacy `beat_transformer_minimal` entry; safe to ignore. The three model submodules are what count. |

## Differences from upstream

| Original project | In this fork |
| --- | --- |
| Gemini for Roman numerals, enharmonic correction and key detection | Local rule-based harmony engine (`POST /api/analyze-harmony`) plus audio-based key detection |
| Firebase authentication, Firestore, Cloud Storage | SQLite cache and a content-addressed audio folder on disk |
| Music.ai lyric transcription; LRCLIB / Genius lyric lookup; translation | Removed — lyrics come from embedded tags or a file you pick, with no translation |
| YouTube URL input, YouTube search, `yt-dlp` extraction | Removed — analysis starts from a local file |
| Hosted AI assistant / chatbot | Replaced by the offline AI prompt export |
| SongFormer segmentation overlays | Code and service documentation remain; the UI entry point is disabled |
| Sheet Sage on Cloud Run | Kept as an optional local service on port `8082` |
| Cloud and Docker deployment files, upstream CI workflows | Still in the tree for reference; not part of the supported setup |

## Contributing

Contributions are welcome — bug reports, documentation, testing and code. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE). Original project: [ptnghia-j/ChordMiniApp](https://github.com/ptnghia-j/ChordMiniApp).

## Citation

If you use ChordMini in academic work, please cite:

```bibtex
@misc{phan2026enhancingautomaticchordrecognition,
      title={Enhancing Automatic Chord Recognition via Pseudo-Labeling and Knowledge Distillation},
      author={Nghia Phan and Rong Jin and Gang Liu and Xiao Dong},
      year={2026},
      eprint={2602.19778},
      archivePrefix={arXiv},
      primaryClass={cs.SD},
      url={https://arxiv.org/abs/2602.19778},
}
```

## Acknowledgements

Thanks to the projects this app builds on:

- **madmom** — [CPJKU/madmom](https://github.com/CPJKU/madmom) — beat detection and audio processing
- **ISMIR2019-Large-Vocabulary-Chord-Recognition** — [music-x-lab](https://github.com/music-x-lab/ISMIR2019-Large-Vocabulary-Chord-Recognition) — the Chord-CNN-LSTM model
- **ChordMini models** — [ptnghia-j/ChordMini](https://github.com/ptnghia-j/ChordMini) — BTC-SL and BTC-PL chord recognition models
- **chords-db** — [tombatossals/chords-db](https://github.com/tombatossals/chords-db) — guitar diagram fingerings
- **SheetSage** — [chrisdonahue/sheetsage](https://github.com/chrisdonahue/sheetsage) — experimental melody transcription
- **OpenSheetMusicDisplay** — [opensheetmusicdisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay) — sheet music rendering
- **music21** — [PyPI](https://pypi.org/project/music21/) · [docs](https://music21.org/music21docs/) — music theory primitives behind the local harmony engine
- **Spleeter** — [deezer/spleeter](https://github.com/deezer/spleeter) — source separation used by the Beat-Transformer path
- **smplr** — [danigb/smplr](https://github.com/danigb/smplr) — web-audio soundfont playback for the chord preview