# Panduan Migrasi & Deploy ke VPS / AWS EC2

Panduan ini menjelaskan cara memindahkan Telegram Cloud Drive dari laptop ke server
selalu-hidup (AWS EC2 Free Tier, lalu VPS mana pun), supaya **bisa diakses dari device
lain** dan **upload file besar tinggal "terima beres"** — Anda upload satu file, server
yang memecah (<2 GB/part) dan mengirim ke Telegram.

> Bahasa Indonesia karena ini panduan operasional untuk pemilik repo. Referensi konsep
> ada di [`ARCHITECTURE.md`](./ARCHITECTURE.md), alur di [`BUSINESS-FLOWS.md`](./BUSINESS-FLOWS.md),
> peta file di [`CODE-MAP.md`](./CODE-MAP.md).

---

## 1. Apa yang berubah dari versi laptop

| Dulu (laptop) | Sekarang (server) |
|---|---|
| Upload = pilih **path lokal**; watcher baca dari disk laptop | Upload = **kirim file lewat browser** (resumable) ke server; watcher baca dari folder staging bersama |
| File Besar di-split 7-Zip di laptop sebelum upload | **Server** yang split otomatis (raw streaming, <2 GB/part) — Anda tidak split manual |
| Watcher & bot hanya jalan di Windows | Jalan di Linux juga; dikelola **Docker Compose** |
| Reassembly download = `7z x` | Reassembly = gabung biasa: `copy /b a+b out` / `cat a b > out` |

Yang **tidak** berubah: Turso tetap otak metadata, channel Telegram tetap penyimpanan,
caption contract `Title | i/total | tags`, slug immutable, soft-delete + purge >7 hari.

Mode lama (browse path di mesin yang sama) **tetap ada** di tab "Host path (advanced)"
untuk pemakaian di laptop — bukan lagi jalur utama.

---

## 2. Alur upload baru (menjawab kekhawatiran "corrupt / ulang dari awal")

```
Browser (device apa pun)                Server (EC2/VPS)                 Telegram
  pilih 1 file besar  ──chunk 16MB──▶  /api/upload (append, resumable)
       (koneksi putus? lanjut dari offset terakhir, TIDAK ulang)
  selesai  ───────────────────────▶  /api/upload/complete → upload_jobs
                                       watcher: streaming split <2GB
                                         part 1 ─ kirim ─ hapus ─┐
                                         part 2 ─ kirim ─ hapus ─┼──▶ pesan di channel
                                         …       checkpoint/part ─┘
                                       sukses → hapus file staging
```

Dua perlindungan terhadap koneksi tidak stabil:

1. **Resumable upload device→server.** File dikirim per potongan 16 MB. Kalau putus,
   browser tanya `GET /api/upload` posisi byte terakhir di server lalu lanjut dari sana —
   **bukan mulai dari nol, bukan corrupt** (server cek offset; potongan nyasar ditolak 409
   lalu disinkronkan ulang).
2. **Checkpoint per-part server→Telegram.** `parts_done` mencatat part yang sudah naik.
   Kalau gagal di tengah, tombol **Retry** melanjutkan dari part berikutnya, bukan
   mengulang seluruh file. Hop server→Telegram juga jauh lebih stabil (koneksi datacenter)
   daripada laptop rumah.

---

## 3. Realita AWS EC2 Free Tier (baca sebelum pilih spek)

Sumber: [AWS Free Tier docs](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-limits.html),
[AWS Free Tier 2025](https://builder.aws.com/content/30mPEVUw3fzFwtEzPurrkoRXAIO/aws-free-tier-2025-whats-free-and-for-how-long).

- **Akun baru (≥ 15 Juli 2025):** kredit **$100 (bisa $200), berlaku 6 bulan**. Instance
  free-tier-eligible lebih luas: **t3.micro, t3.small, t4g.micro, t4g.small,
  c7i-flex.large, m7i-flex.large**. Jadi Anda boleh pilih spek lebih besar dari yang
  termurah — selama kredit/6 bulan belum habis.
- **Akun lama (< 15 Juli 2025):** 750 jam/bulan t2/t3.micro (1 GB RAM), 12 bulan.
- **Disk EBS gratis hanya 30 GB** di kedua skema. Ini **leher botol** untuk file besar.
- **Egress ~100 GB/bulan** gratis. Upload server→Telegram dihitung egress; download pakai
  `copy_message` (sisi Telegram) = **0 egress**.

### Hitungan disk untuk file besar ~20 GB

Streaming split menjaga disk: file ter-stage + **1 part** saja (part lama langsung dihapus).

```
file ter-stage 20 GB  +  1 part (~1.5 GB)  ≈ 21.5 GB puncak  →  MUAT di 30 GB (mepet)
```

**Rekomendasi:** **t3.small (2 GB RAM) + EBS 45–50 GB** (ditanggung kredit $200 di akun
baru). RAM 1 GB pada `t3.micro` sesak untuk web+bot+watcher → minimal tambah swap 2 GB.
EBS 30 GB murni cukup untuk file besar **≤ ~25 GB satu per satu**, tanpa margin aman.

> Karena Free Tier ada masa berlakunya, seluruh stack dibungkus Docker → migrasi ke VPS
> lain tinggal pindah folder (lihat §6).

---

## 4. Persiapan (sekali saja)

1. **Turso**: jalankan skema:
   ```bash
   turso db shell <db-anda> < bot/schema.sql
   ```
2. **Telethon session**: login sekali untuk membuat `bot/worker.session` (di mesin mana
   pun yang punya nomor Telegram Anda), lalu salin file `worker.session` ke server di
   `bot/worker.session`. File ini di-bind-mount ke kontainer watcher.
3. **Bot admin** di channel penyimpanan (sudah seperti sebelumnya).

---

## 5. Deploy di EC2 dengan Docker

```bash
# 0) Instance: Ubuntu/Amazon Linux, t3.small, EBS 50 GB, security group buka port 22 + 3000
#    (atau 80/443 jika pakai reverse proxy). Tambah swap kalau RAM 1 GB:
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile

# 1) Install Docker + compose plugin
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker

# 2) Ambil kode + konfigurasi
git clone <repo-anda> tcd && cd tcd
cp .env.example .env && nano .env          # isi semua kredensial
#    pastikan bot/worker.session sudah ada (lihat §4.2)

# 3) Jalankan
docker compose up -d --build
docker compose logs -f                      # cek bot & watcher konek, web siap

# 4) Buka  http://<IP-EC2>:3000   (login pakai APP_PASSWORD)
```

Catatan:
- **Tombol Start/Stop watcher & bot beserta display status liveness (heartbeat) di UI sudah dihapus**. Bot & watcher dikelola secara terpisah di luar web dashboard (misalnya sebagai compose service `restart: unless-stopped` di Docker, atau dijalankan secara manual di terminal/background).
- Untuk domain + HTTPS, taruh **Caddy/Nginx** di depan service `web` (port 3000). Upload
  besar **harus** lewat server ini, jangan lewat Vercel (batas body kecil).
- Folder staging adalah volume Docker `staging`, dibagi web ↔ watcher. Tidak perlu diatur
  manual.

---

## 6. Migrasi ke VPS lain nanti (saat Free Tier habis)

Karena semuanya Docker + Turso eksternal, pindah host = pindah 3 hal:

```bash
# di server lama: cukup butuh repo, .env, dan worker.session (data ada di Turso & Telegram)
scp .env bot/worker.session user@vps-baru:~/tcd/

# di VPS baru:
git clone <repo> tcd && cd tcd
# letakkan .env dan bot/worker.session, lalu:
docker compose up -d --build
```

Tidak ada migrasi database (Turso tetap), tidak ada migrasi file (tetap di Telegram).
Arahkan ulang domain → IP baru. Selesai.

---

## 7. Kelebihan & Kelemahan

### Kelebihan
- ✅ **Akses dari device mana pun** (browser) — dashboard + download + upload.
- ✅ **Upload "terima beres"**: 1 file → server yang split & kirim, lalu bersih sendiri.
- ✅ **Tahan koneksi putus**: resumable per-chunk + checkpoint per-part (tidak ulang/corrupt).
- ✅ **Hemat disk** lewat streaming split (puncak ≈ ukuran file + 1 part).
- ✅ **Portabel**: pindah VPS = `docker compose up` (Turso & Telegram tak ikut pindah).
- ✅ **Bot ringan**: download pakai `copy_message`, tidak streaming byte → cocok spek kecil.
- ✅ **Download gratis egress** (sisi Telegram).

### Kelemahan / hal yang perlu disadari
- ⚠️ **Disk Free Tier 30 GB ketat** untuk file besar ~20 GB (puncak ~21.5 GB). Disarankan EBS
  45–50 GB. File Besar **> ~28 GB** butuh disk lebih besar.
- ⚠️ **Egress 100 GB/bulan**: total ukuran semua upload per bulan tidak boleh lewat itu
  (download tidak dihitung).
- ⚠️ **RAM 1 GB (t3.micro) sesak** untuk web+bot+watcher → pakai t3.small atau swap.
- ⚠️ **Free Tier ada masanya** (6 bulan/12 month) → harus migrasi lagi (sudah dimudahkan).
- ⚠️ **Reassembly download berubah** untuk upload baru: gabung biasa, bukan `7z x`
  (archive lama yang sudah 7-Zip tetap `7z x`).
- ⚠️ **Upload tetap lewat server** (2 hop: device→server→Telegram). Hop pertama bergantung
  koneksi upload Anda; resumable yang menjaganya, bukan menghilangkannya.
- ⚠️ **`worker.session` itu kredensial akun Telegram Anda** — jaga, jangan commit (sudah
  di `.gitignore` & `.dockerignore`).
- ⚠️ **Folder** harus dibungkus jadi 1 file dulu (zip biasa) sebelum upload;
  server hanya men-split file tunggal.

---

## 8. Variabel lingkungan (ringkas)

Lihat [`.env.example`](../.env.example). Yang penting untuk mode server:

| Var | Dipakai | Catatan |
|---|---|---|
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | semua | otak metadata |
| `BOT_TOKEN`, `STORAGE_CHANNEL_ID`, `OWNER_USER_ID` | bot, web | indeks/download/purge |
| `TG_API_ID`, `TG_API_HASH` | watcher | Telethon (MTProto) |
| `NEXT_PUBLIC_BOT_USERNAME` | web (build) | deep link download — di-inline saat build |
| `APP_PASSWORD` | web | login dashboard; kosong = tanpa auth |
| `UPLOAD_STAGING_DIR` | web+watcher | diset compose ke `/staging` (volume bersama) |
| `WORKER_OUT_DIR` | watcher | diset compose ke `/staging/_parts` |

---

## 9. Deploy Otomatis (CI/CD via GitHub Actions)

Untuk memisahkan proses pengujian (CI) dan penyebaran (CD):
1. **CI (Continuous Integration)** dikonfigurasi di [.github/workflows/ci.yml](file:///D:/coding/Cloud-Drive-Telegram/.github/workflows/ci.yml) dan **hanya berjalan saat ada Pull Request** ke branch `main`.
2. **CD (Continuous Deployment)** dikonfigurasi di [.github/workflows/deploy.yml](file:///D:/coding/Cloud-Drive-Telegram/.github/workflows/deploy.yml) dan **hanya berjalan saat ada `push` atau merge langsung** ke branch `main`.

### A. Persiapan Secrets di GitHub Repository
Buka repository GitHub Anda, masuk ke **Settings > Secrets and variables > Actions**, lalu tambahkan **Repository Secrets** berikut:

1. **`VPS_SSH_HOST`**: IP Public VPS / EC2 Anda (contoh: `54.255.x.x` atau domain DNS public).
2. **`VPS_SSH_USERNAME`**: Username SSH Anda (biasanya `ubuntu` untuk instance Ubuntu EC2 atau `ec2-user` untuk Amazon Linux).
3. **`VPS_SSH_KEY`**: Isi private key SSH Anda (dari file `.pem` yang digunakan saat login ke EC2 VPS). Pastikan menyalin seluruh isinya termasuk baris header `-----BEGIN OPENSSH PRIVATE KEY-----` dan footer `-----END OPENSSH PRIVATE KEY-----`.
4. **`VPS_DEPLOY_PATH`**: Path folder repository di server VPS Anda (contoh: `/home/ubuntu/tcd`).
5. **`VPS_SSH_PORT`** *(Opsional)*: Port SSH VPS Anda. Secara default menggunakan port `22` jika tidak didefinisikan.

### B. Konfigurasi Git Deploy Key di VPS (Penting untuk Private Repo)
Agar server EC2 bisa melakukan `git pull` dari GitHub secara otomatis tanpa meminta password/interaksi:
1. Hubungkan ke VPS via SSH.
2. Generate SSH key baru di VPS:
   ```bash
   ssh-keygen -t ed25519 -C "vps-deploy-key"
   ```
   (Tekan Enter terus sampai selesai tanpa memasukkan passphrase).
3. Ambil isi public key yang baru dibuat:
   ```bash
   cat ~/.ssh/id_ed25519.pub
   ```
4. Di GitHub, buka halaman repository Anda, lalu pergi ke **Settings > Deploy keys > Add deploy key**:
   - Berikan judul (misal: `VPS Deploy Key`).
   - Tempel isi public key tadi.
   - **TIDAK PERLU** mencentang *"Allow write access"* (akses read-only sudah cukup).
   - Klik **Add key**.
5. Uji koneksi git di VPS secara manual sekali agar host GitHub masuk ke `known_hosts`:
   ```bash
   ssh -T git@github.com
   ```
   Ketik `yes` jika ditanya konfirmasi sidik jari host.

### C. Alur Kerja Deployment Otomatis
1. **Saat ada Pull Request ke branch `main`**:
   - GitHub Actions memicu workflow CI ([ci.yml](file:///D:/coding/Cloud-Drive-Telegram/.github/workflows/ci.yml)).
   - Menjalankan **Linting & Build Test** untuk Next.js (`web`).
   - Menjalankan **Syntax Check** untuk Python (`bot`).
   - *Deploy tidak berjalan di tahap ini.*
2. **Saat Pull Request disetujui & digabungkan (merge), atau ada push langsung ke branch `main`**:
   - GitHub Actions memicu workflow Deploy ([deploy.yml](file:///D:/coding/Cloud-Drive-Telegram/.github/workflows/deploy.yml)).
   - Terkoneksi ke EC2 VPS menggunakan SSH Key yang terdaftar di Secrets.
   - Masuk ke folder target di VPS (`VPS_DEPLOY_PATH`).
   - Menjalankan `git pull origin main`.
   - Menjalankan `docker compose up -d --build` untuk membangun ulang kontainer yang berubah dan menjalankannya kembali di background.
   - Melakukan pembersihan image docker lama yang tidak terpakai (`docker image prune -f`).

