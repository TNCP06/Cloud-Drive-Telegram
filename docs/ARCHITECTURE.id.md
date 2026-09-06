# Arsitektur

**Bahasa:** Indonesia · [English](./ARCHITECTURE.md)

Telegram Cloud Drive menggunakan Telegram sebagai penyimpanan byte permanen, PostgreSQL sebagai metadata dan sistem job, service Python sebagai penghubung Telegram/media, serta Next.js sebagai dashboard dan batas HTTP.

## Topologi

```text
Browser -> Next.js actions/API -> PostgreSQL
       -> proxy stream terautentikasi -> streamer -> Telegram
Telegram channel -> bot/indexing -> PostgreSQL
Command web/Telegram -> tabel job -> watcher/bot workers
```

Koordinasi normal menggunakan state PostgreSQL dan event `NOTIFY`. Service tidak memanggil RPC privat satu sama lain.

## Service

- Web: dashboard, server actions, autentikasi, upload, proxy media.
- Bot: command Telegram, otorisasi, Bot Drop, indexing, download, purge, backup.
- Indexer: parsing post channel dan backfill history.
- Watcher: klaim job upload, split/segment, upload, unpack/import/purge.
- Streamer: HTTP range streaming, cache, poster, subtitle, kompresi.
- PostgreSQL: katalog, queue, tombstone, index, trigger notifikasi.

## Invarian Penting

- Caption: `Title | part/total | tag1, tag2`.
- Arsip wajib mengikuti contract; media boleh menurunkan metadata.
- `items.slug` immutable dan menjadi kunci deep-link download.
- `parts.channel_msg_id` unik dan menjadi kunci idempotensi indexing.
- Data Main dan Private dipisahkan oleh `is_private`.
- Arsip boleh binary-split; video besar wajib memakai segment ffmpeg yang playable.
- Thumbnail dan subtitle manual mengalahkan artifact otomatis.

Detail upload, streaming, storage, dan konfigurasi: lihat [dokumen English](./ARCHITECTURE.md).
