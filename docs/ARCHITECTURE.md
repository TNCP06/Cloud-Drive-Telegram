# Architecture

**Language:** English (default) · [Bahasa Indonesia](./ARCHITECTURE.id.md)

Telegram Cloud Drive uses Telegram as the durable byte store, PostgreSQL as the metadata and job
system, Python services as the Telegram/media bridge, and Next.js as the dashboard and HTTP boundary.

## Runtime Topology

```text
Browser
  -> Next.js web actions/API -> PostgreSQL
  -> authenticated stream proxy -> streamer -> local Bot API or Telethon -> Telegram

Telegram channel -> bot/indexing -> PostgreSQL
Web/Telegram commands -> PostgreSQL job tables -> watcher/bot workers -> Telegram or staging
```

Normal coordination is durable PostgreSQL state and `NOTIFY` events. Services do not call each other
through private application RPCs.

| Service | Entry point | Responsibility |
|---|---|---|
| Web | `web/` | Next.js 15 dashboard, server actions, authentication, uploads, media/document proxies |
| Bot | `bot/bot.py` | Telegram commands, authorization, Bot Drop, live indexing, downloads, purge, backups |
| Indexer | `bot/indexing.py`, `bot/index_history.py` | Parse channel messages and backfill history into the catalog |
| Watcher | `bot/watcher.py` | Claim upload jobs, split/segment files, upload parts, unpack/import/purge workers |
| Streamer | `bot/streamer.py` | FastAPI range streaming, sparse cache, local Bot API delivery, posters, subtitles, compression |
| PostgreSQL | `bot/schema.sql` | Catalog, job queues, tombstones, authorization, indexes, notification triggers |
| Local Bot API | Compose `telegram-bot-api` | Local Telegram API and shared file cache/upload path |
| OpenList | Compose `cloud` profile | Optional WebDAV bridge for configured cloud drives |
| Cloudflared | Compose `tunnel` profile | Optional public HTTPS tunnel to the internal streamer |

## Durable Data

The core catalog is `folders`, `items`, `parts`, `tags`, `item_tags`, `thumbnails`, and `subtitles`.
The job tables are `upload_jobs`, `download_jobs`, `unpack_jobs`, and `tg_import_jobs`. The
`purged_messages` table records Telegram message tombstones so history indexing cannot resurrect
permanently deleted data.

The main invariants are:

- Captions use `Title | part/total | tag1, tag2`.
- Archives require the caption contract; media can derive metadata.
- `items.slug` is immutable and is the download deep-link key.
- `parts.channel_msg_id` is unique and is the indexing idempotency key.
- Main and Private rows are separated by `is_private` and authorized independently.
- Raw binary splitting is allowed for archives/documents; oversized videos use playable ffmpeg segments.
- Manual thumbnails and subtitles take precedence over generated artifacts.

## Upload and Indexing

Browser uploads append 16 MiB chunks under the shared staging directory. Completion creates an
`upload_jobs` row. The watcher claims it with `FOR UPDATE SKIP LOCKED`, uploads or segments the
file, and removes staging data after success. Telethon uploads are indexed by the bot's channel-post
handler; Bot API uploads are indexed inline because Telegram does not echo the bot's own post as a
`channel_post` update.

The watcher starts `index_history.py` before `watcher.py` in Compose. History indexing skips both
already-indexed `parts.channel_msg_id` values and `purged_messages` tombstones.

## Streaming

The browser requests `/api/stream/{partId}`. Next.js authenticates the part and proxies the range
request to the internal streamer. With `STREAM_LOCAL_ORIGINAL=1` and the local Bot API configured,
the streamer can materialize the original and serve ranges from disk, enabling compression, posters,
and seek previews. With it disabled, playback uses Telethon sparse chunk downloads and the expendable
`cache` volume; the full original is not retained.

## Storage

| Compose volume/path | Behavior |
|---|---|
| `pgdata` | Persistent PostgreSQL metadata and queues |
| `staging` | Browser/remote/import/unpack staging shared by web, bot, watcher, and local Bot API |
| `cache` | Expendable streamer cache |
| `compressed` | Persistent generated video copies |
| `subtitles` | Persistent generated/manual WebVTT tracks |
| `seekpreviews` | Persistent seek-preview sprite assets |
| `telegram-bot-api-data` | Local Bot API files/cache |
| `openlist-data` | Optional OpenList configuration and credentials |

Telegram account sessions (`bot/worker.session` and `bot/streamer.session`), `.env` files, logs, and
credentials are secret state and must never be committed.

## Configuration

Docker uses the root `.env.example` as the template. Local Windows mode uses `bot/.env.example` and
`web/.env.local.example`; both processes must point at the same PostgreSQL database and staging paths
when local-path uploads are used. The web database wrapper and bot PostgreSQL client preserve `?`
placeholders while translating them to PostgreSQL parameters.
