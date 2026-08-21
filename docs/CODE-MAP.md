# Code Map

This is the current ownership map for the public entry points and the main flows.

## Web

| Path | Responsibility |
|---|---|
| `web/app/page.tsx` | Main drive page |
| `web/app/private/page.tsx` | PIN-gated Private space |
| `web/app/trash/page.tsx` | Trash view |
| `web/app/upload/page.tsx` | Upload queue page |
| `web/app/upload-bot/page.tsx` | Bot Drop page |
| `web/app/stats/page.tsx` | Main-space statistics |
| `web/app/actions/items.ts` | Item metadata, trash, purge, archive unpack |
| `web/app/actions/folders.ts` | Folder CRUD, moves, recursive trash/restore |
| `web/app/actions/tags.ts` | Tag CRUD and relation mutations |
| `web/app/actions/uploads.ts` | Upload-job state transitions |
| `web/app/actions/botDrop.ts` | Owner-source Telegram copy and inline indexing |
| `web/app/actions/private.ts` | Private PIN lock/unlock and space moves |
| `web/app/actions/thumbnails.ts` | Gallery, manual thumbnails, reharvest |
| `web/app/actions/subtitles.ts` | Subtitle listing and mutations |
| `web/app/actions/filesystem.ts` | Authenticated local filesystem browsing |
| `web/app/actions.ts` | Public server-action barrel |
| `web/app/api/upload/route.ts` | Resumable staging chunks |
| `web/app/api/upload/complete/route.ts` | Finalize staging and create upload job |
| `web/app/api/stream/[partId]/route.ts` | Authorized range-stream proxy |
| `web/app/api/events/route.ts` | PostgreSQL notification to browser SSE |
| `web/lib/db.ts` | PostgreSQL/PGlite database wrapper and placeholder translation |
| `web/lib/items.ts` | Drive query/view models |
| `web/lib/resourceAuth.ts` | Item/part/folder authorization |
| `web/lib/staging.ts` | Safe staging path handling |
| `web/lib/driveEvents.ts` | Shared PostgreSQL LISTEN connection |
| `web/components/DriveApp.tsx` | Dashboard orchestration and optimistic mutations |
| `web/components/PreviewDrawer.tsx` | Media/document preview UI |
| `web/components/UploadProvider.tsx` | Client upload queue and persistence |

## Bot

| Path | Responsibility |
|---|---|
| `bot/bot.py` | Telegram handlers, scheduling, authorization, purge, backup orchestration |
| `bot/bot_config.py` | Environment/configuration and drive registry |
| `bot/indexing.py` | Live channel-post parsing, catalog mutations, thumbnails |
| `bot/index_history.py` | Telethon history backfill |
| `bot/db_ops.py` | PostgreSQL catalog upserts, totals, tags, tombstones |
| `bot/pg_db.py` | Async PostgreSQL pool and transaction wrapper |
| `bot/watcher.py` | Upload queue executor and worker-loop composition |
| `bot/unpack.py` | Archive download, extraction, and upload-job creation |
| `bot/tg_import.py` | Telegram message-link import worker |
| `bot/pikpak.py` | PikPak/OpenList rclone download worker |
| `bot/url_download.py` | Streamtape/Gofile download worker |
| `bot/tg_botapi_upload.py` | Local Bot API upload fast path |
| `bot/streamer.py` | FastAPI range server and background backfill loops |
| `bot/stream_compress.py` | Video transcoding and local range serving |
| `bot/stream_subtitles.py` | Whisper transcription, translation, VTT persistence |
| `bot/stream_poster.py` | Generated video covers |
| `bot/stream_seekpreview.py` | Seek-preview sprite generation |
| `bot/schema.sql` | PostgreSQL schema, indexes, foreign keys, NOTIFY triggers |
| `bot/apply_schema.py` | Idempotent schema application for non-Docker PostgreSQL |
| `bot/login.py` | Interactive Telethon session creation |

## Compose and Operations

- `docker-compose.yml` defines `web`, `postgres`, `telegram-bot-api`, `bot`, `watcher`, and
  `streamer`; `openlist` and `cloudflared` are profile-gated.
- `setup.sh` is the Linux Docker setup path.
- `setup.bat` is the Windows local-process setup path.
- `bot/run-all.cmd` starts bot, watcher, and streamer in minimized Windows terminals.
- `.github/workflows/ci.yml` runs PR lint/typecheck/build and Python syntax checks.
- `.github/workflows/cd.yml` deploys `main` to the configured VPS over SSH.
