# Rancangan Fitur: Video Streaming dari Web Dashboard

> Hasil konsolidasi diskusi. **Belum diimplementasi** — review dulu, beri aba-aba untuk mulai.

---

## Prinsip Desain

1. **Sparse caching** — hanya simpan bagian video yang pernah ditonton, bukan seluruh file
2. **YouTube-style prefetch** — server proaktif download beberapa MB ke depan dari posisi play, lalu pause
3. **Cache = expendable** — semua cache bisa dihapus kapan saja tanpa kehilangan data (sumber tetap Telegram)
4. **Channel tetap privat** — tidak ada public channel, tidak ada embed Telegram
5. **Hanya video single-part** — video multi-part (yang di-split saat upload) tidak bisa di-stream

---

## Arsitektur

### Komponen Baru

```
                 Komponen Baru
                 ─────────────
                 ┌─────────────────────────────┐
                 │  streamer.py (FastAPI)       │
                 │  ├─ /stream/{part_id}        │  ← serve chunks + trigger prefetch
                 │  ├─ Telethon iter_download   │  ← download parsial dari Telegram
                 │  ├─ Prefetch manager         │  ← background download ke depan
                 │  └─ Cache manager (LRU)      │  ← auto-cleanup saat disk penuh
                 └─────────────────────────────┘
```

### Posisi dalam Stack

```
Browser                    Next.js                 streamer.py              Telegram
  │                          │                        │                       │
  │  GET /api/stream/123     │                        │                       │
  │  Range: bytes=0-         │                        │                       │
  │ ─────────────────────▶   │                        │                       │
  │                          │  proxy + auth           │                       │
  │                          │ ─────────────────────▶  │                       │
  │                          │                        │  cache hit?            │
  │                          │                        │ ──── cek disk          │
  │                          │                        │                       │
  │                          │                        │  MISS → iter_download  │
  │                          │                        │ ─────────────────────▶ │
  │                          │                        │ ◀───── bytes ───────── │
  │                          │                        │  simpan chunk ke disk  │
  │                          │                        │  + start prefetch bg   │
  │                          │                        │                       │
  │  ◀─── 206 Partial ─────  │  ◀── stream bytes ──  │                       │
  │       Content             │                        │                       │
  │                          │                        │                       │
  │  GET Range: bytes=2M-    │                        │                       │
  │ ─────────────────────▶   │ ─────────────────────▶ │                       │
  │                          │                        │  HIT ✅ (prefetch      │
  │  ◀─── 206 (dari cache)  │  ◀── dari disk ──────  │   sudah download)     │
```

### Docker Compose (tambahan)

```yaml
  # Ditambah di docker-compose.yml
  streamer:
    build:
      context: .
      dockerfile: bot/Dockerfile         # image sama (Python + Telethon + ffmpeg)
    command: ["python", "-u", "streamer.py"]
    env_file: .env
    environment:
      CACHE_DIR: /cache
      CACHE_MAX_SIZE_GB: "20"            # auto-cleanup jika melebihi ini
      PREFETCH_BUFFER_MB: "10"           # buffer ke depan dari posisi play
      CHUNK_SIZE_MB: "2"                 # ukuran per chunk file di disk
    volumes:
      - cache:/cache                     # volume khusus cache (expendable)
      - ./bot/streamer.session:/app/streamer.session
    restart: unless-stopped

volumes:
  staging:
  cache:         # BARU — bisa di-prune kapan saja tanpa kehilangan data
```

> [!NOTE]
> `streamer.session` = session Telethon terpisah dari `worker.session`. Login sekali
> (`python login.py --session streamer`), lalu bind-mount ke container. Telegram mengizinkan
> beberapa session aktif sekaligus dari akun yang sama.

---

## Konsep Sparse Chunk Cache

### Struktur Disk

```
/cache/
  part_123/                        ← 1 folder per video (keyed by parts.id)
    meta.json                      ← metadata: total size, MIME, last accessed
    chunk_000000                   ← bytes 0 – 2,097,151        (2 MB)
    chunk_000001                   ← bytes 2,097,152 – 4,194,303
    (chunk_000002 tidak ada)       ← belum pernah ditonton
    (chunk_000003 tidak ada)
    chunk_000004                   ← bytes 8,388,608 – 10,485,759  (dari seek)
    chunk_000005                   ← bytes 10,485,760 – 12,582,911
    ...

  part_456/
    meta.json
    chunk_000000
    ...
```

### meta.json

```json
{
  "part_id": 123,
  "channel_msg_id": 4567,
  "total_size": 524288000,
  "mime": "video/mp4",
  "chunk_size": 2097152,
  "total_chunks": 250,
  "last_accessed": "2026-06-17T00:00:00Z"
}
```

### Rumus chunk

```
chunk_index = floor(byte_offset / CHUNK_SIZE)
chunk_start = chunk_index × CHUNK_SIZE
chunk_end   = min(chunk_start + CHUNK_SIZE - 1, total_size - 1)
```

---

## Alur Detail

### A. User Klik Play (Cold Start — Cache Kosong)

```
1.  Browser <video> kirim:
      GET /api/stream/123
      Range: bytes=0-

2.  Next.js API proxy:
      - Verifikasi auth (cookie APP_PASSWORD)
      - Forward ke streamer:8080/stream/123

3.  streamer.py terima request:
      a. Cek meta.json → tidak ada (pertama kali)
      b. Query Turso:
           SELECT p.channel_msg_id, p.file_size, p.file_name
           FROM parts p JOIN items i ON i.id = p.item_id
           WHERE p.id = 123 AND i.kind = 'media' AND i.deleted_at IS NULL
      c. Buat meta.json
      d. Chunk 0 tidak ada di disk → download dari Telegram:
           client.iter_download(media, offset=0, request_size=CHUNK_SIZE)
      e. Simpan ke chunk_000000
      f. Kirim response:
           HTTP 206 Partial Content
           Content-Range: bytes 0-2097151/524288000
           Content-Type: video/mp4
           Accept-Ranges: bytes
           (body: 2 MB data)
      g. TRIGGER PREFETCH (background task):
           Download chunk 1, 2, 3, 4 ... sampai buffer limit tercapai
```

### B. Prefetch (Background — YouTube-Style)

```
Konfigurasi: PREFETCH_BUFFER_MB = 10 (artinya ~5 chunk à 2 MB)

Prefetch task untuk part_123, dimulai dari chunk 1:

  while True:
    cached_ahead = (jumlah chunk yang sudah ada di depan posisi play terakhir)
    
    if cached_ahead × CHUNK_SIZE ≥ PREFETCH_BUFFER_MB × 1MB:
        PAUSE — tunggu sampai posisi play maju
        (cek ulang setiap 1-2 detik)
        continue
    
    if chunk_current ≥ total_chunks:
        STOP — video sudah habis
        break

    if chunk_current sudah ada di disk:
        skip, lanjut chunk berikutnya
        continue

    Download chunk_current dari Telegram:
        iter_download(offset=chunk_current × CHUNK_SIZE, request_size=CHUNK_SIZE)
    Simpan ke disk
    chunk_current += 1

  Timeout: jika tidak ada request baru dalam 60 detik → stop prefetch
           (user mungkin sudah menutup video)
```

**Visualisasi:**

```
t=0s   Play dimulai
       [▶···············································]  video 100 MB
        ████▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
        ↑play     ↑prefetch (10 MB)    ↑belum didownload

t=10s  Play maju, prefetch lanjut
       [····▶···········································]
        ████████████▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░
             ↑play        ↑prefetch pause (buffer masih 10 MB)

t=20s  Play maju lagi, buffer menipis, prefetch lanjut
       [·········▶······································]
        ████████████████████▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░
                  ↑play           ↑prefetch lanjut download

████ = sudah di-cache (bisa seek kembali, instan)
▒▒▒▒ = sedang di-prefetch / buffer
░░░░ = belum didownload
```

### C. User Seek ke Posisi Baru

```
Skenario: sedang nonton menit 2, seek ke menit 8

1.  Browser kirim:
      GET /api/stream/123
      Range: bytes=41943040-          ← posisi menit 8

2.  streamer.py:
      a. Hitung: ini chunk_000020
      b. STOP prefetch yang sedang jalan (dari menit 2-3)
      c. Chunk 20 ada di disk?
         - Ya  → serve dari disk ⚡ instan
         - Tidak → download chunk 20 dari Telegram, simpan, serve
      d. START prefetch BARU dari chunk 21 ke depan
      e. Chunk 0-10 (dari menit 0-2 tadi) TETAP di cache
         → jika user seek balik ke menit 1, instan ✅

Visualisasi setelah seek:

  ████████████░░░░░░░░░░████████▒▒▒▒▒▒░░░░░░░░░░░░░░
  ↑ menit 0-2            ↑ menit 8    ↑ prefetch baru
    (masih di cache)        (play)
```

### D. Request Berikutnya (Cache Hit)

```
1.  Browser minta chunk yang sudah di-cache:
      Range: bytes=2097152-4194303     ← chunk 1

2.  streamer.py:
      chunk_000001 ada di disk → serve langsung
      Tidak ada request ke Telegram sama sekali
      Response time: < 5ms ⚡
```

### E. Cache Cleanup (LRU)

```
Konfigurasi: CACHE_MAX_SIZE_GB = 20

Trigger: sebelum download chunk baru, cek total ukuran /cache/

  total = sum(ukuran semua file di /cache/)

  while total + CHUNK_SIZE > CACHE_MAX_SIZE:
      1. Cari folder part_* dengan last_accessed paling lama
      2. Hapus SELURUH folder tersebut (semua chunk-nya)
         (menghapus per-chunk terlalu granular — 1 video = 1 unit eviction)
      3. Hitung ulang total

  Download chunk baru

Contoh:
  /cache/ penuh (20 GB)
  part_789 (last_accessed: 3 hari lalu, 800 MB) → HAPUS
  part_456 (last_accessed: 1 hari lalu, 1.2 GB) → masih aman
  Sekarang ada ~19.2 GB → cukup ruang untuk chunk baru
```

---

## Perubahan per Komponen

### 1. File Baru: `bot/streamer.py` (~250-350 baris)

| Bagian | Tanggung jawab |
|---|---|
| FastAPI app | HTTP server port 8080 |
| `GET /stream/{part_id}` | Parse Range header, cek cache, serve atau download+serve |
| `PrefetchManager` | Background task per-video: download chunk ke depan, pause saat buffer penuh |
| `CacheManager` | Hitung total cache size, LRU eviction |
| Telethon client | `iter_download` dengan `offset` dan `request_size` untuk download parsial |
| Turso lookup | Query `parts` + `items` untuk mendapatkan `channel_msg_id` dan `file_size` |

### 2. File Baru: `web/app/api/stream/[partId]/route.ts` (~50-70 baris)

```
Runtime: nodejs
Fungsi: proxy authenticated ke streamer
Alur:
  1. Cek auth (cookie APP_PASSWORD)
  2. Forward request + Range header ke http://streamer:8080/stream/{partId}
  3. Pipe response stream kembali ke browser (termasuk 206 + Content-Range headers)
```

### 3. Perubahan: `web/components/PreviewDrawer.tsx`

```
Saat ini:
  - Menampilkan <Image> (thumbnail base64) untuk semua media

Sesudah:
  - Deteksi apakah item adalah VIDEO (dari file_name extension atau MIME)
  - Jika video → tampilkan <video> element dengan controls
  - Jika gambar → tetap <Image> seperti sekarang
```

```diff
 // Di viewer-stage
 {active ? (
-  <Image src={active} alt={item.name} fill unoptimized ... />
+  isStreamableVideo(item) ? (
+    <video
+      src={`/api/stream/${item.firstPartId}`}
+      controls
+      autoPlay
+      preload="metadata"
+      style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
+    />
+  ) : (
+    <Image src={active} alt={item.name} fill unoptimized ... />
+  )
 ) : ( ... )
```

### 4. Perubahan: `web/lib/types.ts`

```diff
 export interface DriveFile {
   ...
   thumb: string | null;
+  firstPartId: number | null;   // parts.id dari part pertama (untuk streaming URL)
+  fileName: string | null;      // parts.file_name (untuk deteksi video vs gambar)
 }
```

### 5. Perubahan: `web/lib/items.ts`

```
getDriveData() sudah query parts untuk cover thumbnail.
Tambahkan: ambil juga parts.id dan parts.file_name dari part pertama
→ populate firstPartId dan fileName di DriveFile.
```

### 6. Perubahan: `docker-compose.yml`

```
Tambah service `streamer` + volume `cache` (lihat bagian arsitektur di atas).
```

### 7. Tidak Berubah

| File | Alasan |
|---|---|
| `bot/bot.py` | Indexing, download, purge — tidak terkait streaming |
| `bot/watcher.py` | Upload queue — tidak terkait streaming |
| `bot/worker.py` | CLI upload — tidak terkait streaming |
| `bot/schema.sql` | Skema cukup, tidak perlu kolom baru |

---

## Batasan

| Batasan | Detail |
|---|---|
| **Hanya video single-part** | Video yang di-split saat upload (>2 GB, multi-part) tidak bisa di-stream tanpa reassembly |
| **Butuh session Telethon tambahan** | `streamer.session` — login sekali, bind-mount ke container |
| **Egress VPS** | Setiap streaming = bandwidth VPS. Tapi cache mengurangi ini: nonton ulang = 0 egress |
| **Latency pertama kali** | ~200-500ms sebelum byte pertama saat cache miss. Setelah prefetch jalan, mulus |
| **Concurrent streams** | Telegram flood limit. Aman ~3-5 viewer paralel; lebih dari itu perlu rate limiting |
| **Format video** | Browser hanya bisa play format tertentu (MP4/H.264/WebM). MKV/AVI tidak bisa play di `<video>` tanpa transcoding |

---

## Konfigurasi yang Bisa Diatur

| Variabel | Default | Fungsi |
|---|---|---|
| `CACHE_DIR` | `/cache` | Lokasi cache chunks |
| `CACHE_MAX_SIZE_GB` | `20` | Auto-cleanup (LRU) jika melebihi ini |
| `PREFETCH_BUFFER_MB` | `10` | Seberapa jauh prefetch ke depan dari posisi play |
| `CHUNK_SIZE_MB` | `2` | Ukuran per chunk (granularity cache + Range response) |
| `PREFETCH_TIMEOUT_S` | `60` | Stop prefetch jika tidak ada request baru dalam X detik |

---

## Estimasi Effort

| Task | Baris kode |
|---|---|
| `bot/streamer.py` (FastAPI + Telethon + prefetch + cache manager) | ~300 |
| `web/app/api/stream/[partId]/route.ts` (proxy) | ~60 |
| Perubahan `PreviewDrawer.tsx` (video player) | ~40 |
| Perubahan `types.ts` + `items.ts` (tambah field) | ~20 |
| Perubahan `docker-compose.yml` | ~15 |
| Helper: deteksi video dari filename | ~10 |
| **Total** | **~450 baris** |
