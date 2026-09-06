# Alur Bisnis

**Bahasa:** Indonesia · [English](./BUSINESS-FLOWS.md)

Dokumen ini menjelaskan alur utama Telegram Cloud Drive. Semua proses menggunakan PostgreSQL sebagai koordinasi durable.

## Upload

Browser mengirim chunk ke staging, lalu membuat baris `upload_jobs`. Watcher mengklaim job, melakukan split atau segment bila perlu, mengunggah part ke channel Telegram, dan bot melakukan indexing. Upload folder mempertahankan struktur folder.

Bot Drop menerima file dari private chat. Metadata mengikuti caption atau dilengkapi melalui halaman upload-bot. Arsip wajib memakai format caption `Title | part/total | tag1, tag2`.

## Backup HP

Pilih file atau folder di `/backup-hp`. Semua pilihan masuk satu antrean, file besar di-split otomatis, disk VPS dipantau, dan job gagal dapat diulang. File kecil dapat dikirim melalui `/backup`, lalu akhiri dengan `/backup_done`.

## Download dan Streaming

Download item menggunakan bot deep-link atau tombol dashboard. Video diputar melalui proxy range ke streamer; cache, poster, subtitle, dan kompresi diproses di background sesuai konfigurasi.

## Hapus dan Restore

Trash mengubah metadata terlebih dahulu. Purge permanen membuat tombstone `purged_messages` sebelum row dihapus agar history indexing tidak menghidupkan kembali pesan.

## Private Space dan Tag

Private Space dilindungi PIN dan query Main tidak boleh membaca row private. Tag dikelola di dashboard dan dapat dipasang melalui caption upload.

Untuk urutan langkah, endpoint, dan code path lengkap, lihat [versi English](./BUSINESS-FLOWS.md).
