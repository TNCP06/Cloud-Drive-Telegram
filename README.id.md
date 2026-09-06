# Telegram Cloud Drive

**Bahasa:** Indonesia · [English (default)](README.md)

Penyimpanan cloud pribadi yang efektif tanpa batas dengan dashboard web. Byte disimpan sebagai pesan di **channel Telegram** privat, metadata di **PostgreSQL** self-hosted, dan antarmuka menggunakan **Next.js**.

## Fitur

- Penyimpanan file di channel Telegram privat.
- Indexing otomatis dengan format caption `Title | part/total | tag1, tag2`.
- Dashboard untuk mencari, memberi tag, mengunggah, mengunduh, membuat folder, favorit, sampah, dan streaming video.
- Backup database harian ke Telegram.
- Upload resumable dari browser, banyak file, folder, Bot Drop, atau path host.
- Download jarak jauh dari PikPak/OpenList melalui pipeline upload yang sama.
- Streaming video HTTP range, cache, thumbnail WebP, subtitle, dan kompresi latar belakang.

## Arsitektur Singkat

Semua komponen berkoordinasi melalui tabel job dan event PostgreSQL.

| Komponen | Tanggung jawab |
|---|---|
| Web (`web/`) | Dashboard Next.js, server actions, autentikasi, upload, proxy media |
| Bot (`bot/bot.py`) | Command Telegram, indexing, Bot Drop, download, purge, backup |
| Watcher (`bot/watcher.py`) | Queue upload, split/segment, upload ke Telegram, unpack |
| Streamer (`bot/streamer.py`) | Streaming range, cache, poster, subtitle, kompresi |
| PostgreSQL | Metadata, antrean job, tombstone, otorisasi |

## Instalasi Cepat

Di VPS Linux baru:

```bash
git clone <your-repo-url> cloud-drive && cd cloud-drive
bash setup.sh
```

Di Windows:

```bat
git clone <your-repo-url> cloud-drive
cd cloud-drive
setup.bat
```

Isi nilai Telegram (`BOT_TOKEN`, `STORAGE_CHANNEL_ID`, `OWNER_USER_ID`, `TG_API_ID`, `TG_API_HASH`) dan kredensial PostgreSQL di `.env`. Detail lengkap ada di [Deployment](docs/DEPLOYMENT.id.md).

## Penggunaan

- **Upload:** dashboard → *Upload files*, atau kirim/forward file ke bot.
- **Backup HP:** dashboard → *Backup HP*, atau gunakan `/backup`, kirim file, lalu `/backup_done`.
- **Caption:** gunakan `Title | part/total | tag1, tag2`; path seperti `Folder/Sub/Nama` membuat folder bertingkat.
- **Download:** buka menu item → *Download*.
- **Streaming:** klik video.
- **Tema dan bahasa:** gunakan tombol tema serta toggle `EN`/`ID`.

## Dokumen

- [Arsitektur](docs/ARCHITECTURE.id.md)
- [Alur bisnis](docs/BUSINESS-FLOWS.id.md)
- [Peta kode](docs/CODE-MAP.id.md)
- [Deployment](docs/DEPLOYMENT.id.md)
- [Demo](docs/DEMO.id.md)

## Lisensi

MIT — dibuat untuk penggunaan pribadi.
