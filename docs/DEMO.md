# UI-only demo (Vercel)

A public, backend-free deployment of the dashboard: no Postgres, no Telegram, no bot, no
streamer. It exists so the UI can be shown off (and shared as a link) without exposing the real
drive, and without a Vercel rebuild every time the Python side changes.

## The idea

The demo is **not a separate branch and not a mock layer**. It deploys `main` with one
environment variable set, and swaps exactly two things:

| Production | `DEMO_MODE=1` |
| --- | --- |
| Postgres over `DATABASE_URL` (`pg`) | [PGlite](https://pglite.dev) — the same Postgres engine compiled to WASM — in memory, seeded from `web/lib/demo/seed.ts` |
| `/api/stream/[partId]` proxies the Python streamer | redirects to a static asset under `web/public/demo/` |

Everything else — every query, server action, trigger, `now_text()` call, the `?`→`$n` shim, the
cover-thumbnail route, folders, tags, trash, the private space — runs **unmodified**. The demo is
the real dashboard talking to a real (if tiny) Postgres.

Three files know the demo exists, and that is the whole surface:

- [`web/lib/db.ts`](../web/lib/db.ts) — picks PGlite instead of a `pg` Pool.
- [`web/app/api/stream/[partId]/route.ts`](../web/app/api/stream/[partId]/route.ts) — serves the
  static asset named by the part's `file_id` instead of proxying the streamer.
- [`web/lib/driveEvents.ts`](../web/lib/driveEvents.ts) — one early `return`: there is no server to
  `LISTEN` on, so the SSE reconnect loop is skipped.

> Deliberately *not* done: an `isDemoMode()` helper threaded through the codebase. The demo
> substitutes a data source, so it belongs at the data-source boundary — not at 40 call sites.

## Deploying it

1. **Import the repo on Vercel.** Root Directory → `web`. Framework preset: Next.js.

2. **Environment variables** — set only these:

   | Variable | Value | Why |
   | --- | --- | --- |
   | `DEMO_MODE` | `1` | the switch |
   | `PIN` | any 4–6 digits | unlocks the Private space so it can be demoed |
   | `NEXT_PUBLIC_BOT_USERNAME` | e.g. `CloudDriveDemoBot` | download deep links render (they go nowhere) |

   Leave `DATABASE_URL`, `APP_PASSWORD`, `BOT_TOKEN`, `STORAGE_CHANNEL_ID`, `STREAMER_URL` and
   `STREAMER_SECRET` **unset**. `APP_PASSWORD` in particular: unset means
   [`middleware.ts`](../web/middleware.ts) disables the login gate, which is what a public demo
   wants.

3. **Skip rebuilds for backend-only commits.** Already committed — [`web/vercel.json`](../web/vercel.json):

   ```json
   { "ignoreCommand": "git diff --quiet HEAD^ HEAD -- ." }
   ```

   It runs from the Root Directory (`web/`), so it exits 0 — "skip this build" — whenever a commit
   touched nothing under `web/`. A change to `bot/`, `docs/` or compose costs zero deploys. (The
   dashboard equivalent is *Settings → Build and Deployment → Ignored Build Step*; Vercel has moved
   it between sections over time, which is the other reason to keep it in the repo.) On a first
   deploy `HEAD^` may not resolve — the command then exits non-zero and the build runs, which is the
   behaviour you want.

That's it. No demo branch to keep in sync, no cherry-picking UI fixes into a fork that quietly
rots.

## Running it locally

```bash
# PowerShell
$env:DEMO_MODE = "1"; npm --prefix web run dev

# bash
DEMO_MODE=1 npm --prefix web run dev
```

## Regenerating the data

[`scripts/gen_demo_seed.py`](../scripts/gen_demo_seed.py) writes both halves — the bytes and the
SQL. Needs `ffmpeg` on PATH and Pillow:

```bash
python scripts/gen_demo_seed.py
```

It produces:

- `web/public/demo/*` — every byte the demo serves. All of it is **synthesised** (ffmpeg `lavfi`
  gradients with a burnt-in timecode, Pillow-rendered photos and PDF pages, hand-rolled OOXML for
  the Word/Excel files). No third-party footage, so there is nothing to license or attribute.
- `web/lib/demo/seed.ts` — `bot/schema.sql` **verbatim**, followed by the INSERTs. Re-running the
  script is how the demo schema resyncs with the real one; nothing reads the `.sql` at runtime, so
  Vercel's file tracing never has to find it.

The dataset covers roughly 35 items: streamable video (mp4/mkv/webm), photos (jpg/png/webp/gif), a
multi-part photo album, audio (mp3/flac), documents that really preview inline (pdf, docx, xlsx,
csv, md, txt, srt, and source files), download-only split archives across several parts, two
versions of one archive (so version grouping shows), trashed items, favourites, a PIN-gated private
space, and populated upload/download/unpack queues for `/upload` and `/stats`.

Part → asset mapping reuses `parts.file_id`. In production that column holds a Telegram file id; in
the demo it holds `/demo/<file>`. No schema change, and the stream route needs one lookup.

## Known limits (by design)

- **Writes are per-instance.** Each serverless instance holds its own in-memory database, so a
  rename or a delete is real until that instance is recycled, and invisible to other visitors. For a
  public demo that is the feature, not the bug: nobody can wreck it for the next person.
- **Queues are read-only theatre.** `/upload` and `/stats` render seeded rows; actually queuing an
  upload needs the watcher, which does not exist here.
- **No subtitles or seek previews.** Both come from the streamer. The player already treats them as
  optional, so it degrades quietly.
- **Live refresh is off** — no `NOTIFY`, so the grid does not push-update. Nothing writes from
  outside the browser anyway.
- **Cold start costs a beat.** PGlite boots Postgres from WASM and replays the seed on the first
  request an instance serves.
