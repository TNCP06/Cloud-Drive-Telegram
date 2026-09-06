"use client";

import { useEffect, useRef, useState } from "react";

export type Locale = "en" | "id";

const translations: Record<string, string> = {
  "All files": "Semua file",
  Recent: "Terbaru",
  Favorites: "Favorit",
  Trash: "Sampah",
  Tags: "Tag",
  "Type Tags": "Tag Jenis",
  "Show less": "Tampilkan lebih sedikit",
  "Show more": "Tampilkan lebih banyak",
  "No tags yet.": "Belum ada tag.",
  "Sign out": "Keluar",
  Storage: "Penyimpanan",
  Done: "Selesai",
  Vault: "Vault",
  "Telegram Drive": "Drive Telegram",
  Private: "Pribadi",
  "Locked space": "Ruang terkunci",
  "Back to drive": "Kembali ke drive",
  "Upload files or a folder": "Unggah file atau folder",
  "Create new folder": "Buat folder baru",
  "Empty trash": "Kosongkan sampah",
  "Search files…": "Cari file…",
  "Search results": "Hasil pencarian",
  "Layout & view options": "Opsi tata letak & tampilan",
  "Keyboard shortcuts (?)": "Pintasan keyboard (?)",
  "Open Private space": "Buka ruang pribadi",
  "Exit Private space": "Keluar dari ruang pribadi",
  Details: "Detail",
  Download: "Unduh",
  "Move to folder": "Pindahkan ke folder",
  "Move to private": "Pindahkan ke pribadi",
  "Restore items": "Pulihkan item",
  "Delete permanently": "Hapus permanen",
  Delete: "Hapus",
  "Select all": "Pilih semua",
  "Clear selection": "Hapus pilihan",
  "System map & stats": "Peta sistem & statistik",
  "Stored in Telegram": "Tersimpan di Telegram",
  Items: "Item",
  "VPS disk free": "Disk VPS tersedia",
  "How data moves": "Alur data",
  "Stored bytes by kind": "Byte tersimpan berdasarkan jenis",
  "Top tags": "Tag teratas",
  Jobs: "Pekerjaan",
  "Remote downloads": "Unduhan jarak jauh",
  "Uploads → Telegram": "Unggahan → Telegram",
  "Archive unpacks": "Ekstraksi arsip",
  "Upload files": "Unggah file",
  Type: "Jenis",
  "Destination Space": "Ruang tujuan",
  "Part size (MB)": "Ukuran bagian (MB)",
  Source: "Sumber",
  Pause: "Jeda",
  Stop: "Berhenti",
  Start: "Mulai",
  Remove: "Hapus",
  Retry: "Coba lagi",
  Edit: "Edit",
  Cancel: "Batal",
  "No uploads queued. Add files above.": "Belum ada unggahan dalam antrean. Tambahkan file di atas.",
  "Complete File Details": "Lengkapi Detail File",
  "Access Denied": "Akses Ditolak",
  Saved: "Tersimpan",
  "Categories": "Kategori",
  "Add subtitle": "Tambah subtitle",
  "From Telegram storage": "Dari penyimpanan Telegram",
  "Choose a subtitle file…": "Pilih file subtitle…",
  "Empty folder.": "Folder kosong.",
  "Private space": "Ruang pribadi",
  "Enter your PIN to continue": "Masukkan PIN untuk melanjutkan",
  "Incorrect PIN": "PIN salah",
  "Enter your password to sign in": "Masukkan kata sandi untuk masuk",
  Password: "Kata sandi",
  "Sign in": "Masuk",
  "Loading preview…": "Memuat pratinjau…",
  "Empty document.": "Dokumen kosong.",
  "No data yet.": "Belum ada data.",
  "New category name…": "Nama kategori baru…",
  "Folder name": "Nama folder",
  "Change colour": "Ubah warna",
  "Delete category": "Hapus kategori",
  "PHONE ARCHIVE": "ARSIP HP",
  "Backup HP": "Backup HP",
  "VPS staging": "Staging VPS",
  "Tambahkan dari perangkat": "Tambahkan dari perangkat",
  "Aktivitas VPS terbaru": "Aktivitas VPS terbaru",
  "All versions": "Semua versi",
  "Show all versions": "Tampilkan semua versi",
  Close: "Tutup",
  Reload: "Muat ulang",
  Open: "Buka",
  Save: "Simpan",
  "Save changes": "Simpan perubahan",
  Add: "Tambah",
  Rename: "Ganti nama",
  Restore: "Pulihkan",
  "Mark as favorite": "Tandai sebagai favorit",
  "Remove from favorites": "Hapus dari favorit",
  "Deselect": "Batalkan pilihan",
  "Select": "Pilih",
  "View": "Tampilan",
  Layout: "Tata letak",
  Show: "Tampilkan",
  "Sort by": "Urutkan berdasarkan",
  Order: "Urutan",
  "Path folders": "Folder jalur",
  Name: "Nama",
  Size: "Ukuran",
  Added: "Ditambahkan",
  Location: "Lokasi",
  Thumbnail: "Thumbnail",
  Title: "Judul",
  Folder: "Folder",
  File: "File",
  Media: "Media",
  Archive: "Arsip",
  "No categories yet. Create one above.": "Belum ada kategori. Buat di atas.",
  "Add, rename, recolour, or remove the labels for your archive.": "Tambah, ganti nama, ubah warna, atau hapus label arsip.",
  "Permanently delete": "Hapus permanen",
  "Restore from trash": "Pulihkan dari sampah",
  "Are you sure?": "Yakin?",
  "Add files": "Tambah file",
  "Add folder": "Tambah folder",
  "Choose files": "Pilih file",
  "Choose folder": "Pilih folder",
  "Upload": "Unggah",
  "Uploading": "Mengunggah",
  "uploaded": "terunggah",
  "processing": "memproses",
  "completed": "selesai",
  "failed": "gagal",
  "pending": "menunggu",
  "running": "berjalan",
  "queued": "dalam antrean",
  "Retry failed": "Coba lagi yang gagal",
  "Enter title": "Masukkan judul",
  "Optional": "Opsional",
  "Loading…": "Memuat…",
  "Something went wrong": "Terjadi kesalahan",
  "Try again": "Coba lagi",
  "Back": "Kembali",
  "View storage breakdown": "Lihat rincian penyimpanan",
  "used on": "terpakai di",
  "on": "di",
  Untagged: "Tanpa tag",
  "Hide details pane": "Sembunyikan panel detail",
  "Jump to folder location": "Buka lokasi folder",
  "Delete (remove from queue)": "Hapus (keluarkan dari antrean)",
  "Language / Bahasa": "Bahasa / Language",
  "Details pane": "Panel detail",
  Sidebar: "Bilah sisi",
  "Compact view": "Tampilan ringkas",
  "Item check boxes": "Kotak centang item",
  "File name extensions": "Ekstensi nama file",
  "Group versions": "Kelompokkan versi",
  "Detail items": "Detail item",
  "Select a folder on the laptop": "Pilih folder di laptop",
  "Select a file on the laptop": "Pilih file di laptop",
  Up: "Naik",
  "Select this folder": "Pilih folder ini",
  "Toggle theme": "Ganti tema",
  "Empty folder": "Folder kosong",
  Actions: "Aksi",
  "Uploads complete": "Unggahan selesai",
  "Resume": "Lanjutkan",
  Process: "Proses",
  Completed: "Selesai",
  "No completed uploads yet.": "Belum ada unggahan yang selesai.",
  "Nothing in progress.": "Tidak ada proses yang berjalan.",
  Queued: "Dalam antrean",
  Failed: "Gagal",
  "Queued → Telegram": "Dalam antrean → Telegram",
  "Waiting for watcher": "Menunggu watcher",
  "Uploading → Telegram": "Mengunggah → Telegram",
  Canceled: "Dibatalkan",
  Ready: "Siap",
  "Uploading → VPS": "Mengunggah → VPS",
  Queuing: "Menambahkan ke antrean",
  "Failed to add to queue.": "Gagal menambahkan ke antrean.",
  "Media (single file)": "Media (satu file)",
  "Archive (split)": "Arsip (dipecah)",
  "Main Drive": "Drive Utama",
  "Private Space": "Ruang Pribadi",
  "Upload from this device": "Unggah dari perangkat ini",
  "Host path (advanced)": "Path host (lanjutan)",
  "Add file(s) to queue": "Tambah file ke antrean",
  "Add folder to queue": "Tambah folder ke antrean",
  "Files are queued first — set titles/tags below, then Start.": "File dimasukkan ke antrean dulu — atur judul/tag di bawah, lalu Mulai.",
  "Archive folder/file": "Folder/file arsip",
  "Media file": "File media",
  "path on the host": "path di host",
  "Browse…": "Telusuri…",
  "Reads a file already on the machine that runs the watcher (no transfer).": "Membaca file di mesin yang menjalankan watcher (tanpa transfer).",
  "Add to queue": "Tambah ke antrean",
  Queue: "Antrean",
  live: "aktif",
  "Clear finished": "Bersihkan yang selesai",
  "Move to trash": "Pindahkan ke sampah",
  "Delete forever": "Hapus selamanya",
  "Unlock": "Buka kunci",
  "New folder": "Folder baru",
  Create: "Buat",
  "Rename folder": "Ganti nama folder",
  "Unpack archive": "Ekstrak arsip",
  Unpack: "Ekstrak",
  "Move to main drive": "Pindahkan ke drive utama",
  "Folder details": "Detail folder",
  Subfolders: "Subfolder",
  "Direct contents": "Isi langsung",
  Created: "Dibuat",
  Modified: "Diubah",
  "No results": "Tidak ada hasil",
  "Trash is empty": "Sampah kosong",
  "No favorites yet": "Belum ada favorit",
  "No recent activity": "Belum ada aktivitas terbaru",
  "This tag is empty": "Tag ini kosong",
  "Drive is empty": "Drive kosong",
  "Navigation & selection": "Navigasi & pilihan",
  "Search & actions": "Pencarian & aksi",
  "Media & preview viewer": "Media & penampil pratinjau",
  "Focus search bar": "Fokus ke bilah pencarian",
  "Keyboard shortcuts": "Pintasan keyboard",
  "Ascending": "Menaik",
  "Descending": "Menurun",
  "Group by": "Kelompokkan berdasarkan",
  "Move to...": "Pindahkan ke…",
  "Add to favorites": "Tambah ke favorit",
  "Toggle favorite": "Ganti status favorit",
  "Saving…": "Menyimpan…",
  "Pick colour": "Pilih warna",
  "Click to rename": "Klik untuk mengganti nama",
  Root: "Root",
  Status: "Status",
  Favorite: "Favorit",
  "In Trash": "Di sampah",
  None: "Tidak ada",
  Contents: "Isi",
  Parts: "Bagian",
  "Item title": "Judul item",
  "Edit metadata": "Edit metadata",
  "Re-fetch": "Ambil ulang",
  "Fetch from Telegram": "Ambil dari Telegram",
  "Set thumbnail…": "Atur thumbnail…",
  "Cannot load image.": "Tidak dapat memuat gambar.",
  "Browser cannot decode this video format.": "Browser tidak dapat memutar format video ini.",
  "Video load timed out.": "Waktu pemuatan video habis.",
  "Thumbnail already up-to-date.": "Thumbnail sudah terbaru.",
  "Failed — check bot logs.": "Gagal — periksa log bot.",
  "Extracting frame…": "Mengekstrak frame…",
  "Resizing…": "Mengubah ukuran…",
  "Upload failed.": "Unggahan gagal.",
  "Failed to process file.": "Gagal memproses file.",
  "PDF preview": "Pratinjau PDF",
  "File too large to preview.": "File terlalu besar untuk dipratinjau.",
  "Could not render document.": "Tidak dapat merender dokumen.",
  "Could not render spreadsheet.": "Tidak dapat merender spreadsheet.",
  "Add a category…": "Tambah kategori…",
  "Upload from this device…": "Unggah dari perangkat ini…",
  "Attach": "Lampirkan",
  "Attach failed.": "Gagal melampirkan.",
  "Starting…": "Memulai…",
  "Could not start extraction.": "Tidak dapat memulai ekstraksi.",
  "Failed.": "Gagal.",
  "No subtitle files (.srt/.vtt/.ass) on the drive yet.": "Belum ada file subtitle (.srt/.vtt/.ass) di drive.",
  "Extract from video": "Ekstrak dari video",
  "Switch to light mode": "Beralih ke mode terang",
  "Switch to dark mode": "Beralih ke mode gelap",
  "(None)": "(Tidak ada)",
  "Date modified": "Tanggal diubah",
  Unknown: "Tidak diketahui",
  "Tiny (< 1 MB)": "Sangat kecil (< 1 MB)",
  "Small (1–10 MB)": "Kecil (1–10 MB)",
  "Medium (10–100 MB)": "Sedang (10–100 MB)",
  "Large (100 MB – 1 GB)": "Besar (100 MB – 1 GB)",
  "Huge (> 1 GB)": "Sangat besar (> 1 GB)",
  "VPS disk full — free space, then retry.": "Disk VPS penuh — kosongkan ruang, lalu coba lagi.",
  "Connection lost — progress saved, retry to continue.": "Koneksi terputus — progres tersimpan, coba lagi untuk melanjutkan.",
  "Upload interrupted.": "Unggahan terhenti.",
  "Failed to queue upload.": "Gagal memasukkan unggahan ke antrean.",
  "Invalid upload token.": "Token unggahan tidak valid.",
  "Invalid file name.": "Nama file tidak valid.",
  "Invalid file path.": "Path file tidak valid.",
  "Upload whole phone": "Backup seluruh HP",
  "Archive seluruh HP lama sekaligus": "Backup seluruh HP lama sekaligus",
  "Jeda": "Pause",
  "Bersihkan riwayat selesai": "Clear finished history",
  "Pilih satu atau beberapa folder dari HP, lalu tekan": "Choose one or more folders from your phone, then press",
  "File masuk ke satu antrean, dipecah otomatis bila terlalu besar, dan yang gagal bisa diulang sekaligus.": "Files enter one queue, are split automatically when too large, and failures can be retried together.",
  "Sambungkan charger": "Connect the charger",
  "File saved to Channel! You can close this page.": "File tersimpan ke Channel! Anda dapat menutup halaman ini.",
  "File has been forwarded to the channel in the correct format. The bot is processing its indexing.": "File telah diteruskan ke channel dengan format yang benar. Bot sedang memproses indexing.",
  "Your file has been secured by the bot. Please fill in the details below to add it to the catalog.": "File Anda telah diamankan oleh bot. Isi detail di bawah untuk menambahkannya ke katalog.",
  "e.g. Bali Holiday Video": "contoh: Video Liburan Bali",
  "e.g. holiday, family, 2026": "contoh: liburan, keluarga, 2026",
  "e.g. rpg, fantasy": "contoh: rpg, fantasi",
  "Media (Video / Single Photo)": "Media (Video / Satu Foto)",
  "Archive / Single Document": "Arsip / Satu Dokumen",
  "This page can only be accessed via a special link from your Telegram Bot.": "Halaman ini hanya dapat diakses melalui tautan khusus dari Bot Telegram Anda.",
  "Processes only talk through Postgres job queues (upload · download · unpack).": "Proses hanya berkomunikasi melalui antrean job Postgres (unggah · unduh · ekstrak).",
  "media vs archive bytes": "byte media dibandingkan arsip",
  "Extract embedded subtitles from the video itself (softsub). Downloads the original from Telegram in the background — may take a while for big files.": "Ekstrak subtitle tertanam dari video (softsub). File asli akan diunduh dari Telegram di background — mungkin perlu waktu untuk file besar.",
  "Folders are removed and the files inside them are trashed.": "Folder akan dihapus dan file di dalamnya dipindahkan ke sampah.",
  "Trashed files are automatically removed from Telegram after 7 days.": "File di sampah akan otomatis dihapus dari Telegram setelah 7 hari.",
  "Deleted items appear here for 7 days before being purged.": "Item yang dihapus berada di sini selama 7 hari sebelum dihapus permanen.",
  "Star files to find them here quickly.": "Bintangi file agar mudah ditemukan di sini.",
  "Recently modified files will appear here.": "File yang baru diubah akan muncul di sini.",
  "Tag files via the caption when uploading.": "Tambahkan tag melalui caption saat mengunggah.",
  "Send files to your Telegram channel with the correct caption format to start filling the archive.": "Kirim file ke channel Telegram dengan format caption yang benar untuk mulai mengisi arsip.",
  "Move focus & selection between items": "Pindahkan fokus dan pilihan antar-item",
  "Select range of items": "Pilih rentang item",
  "Open selected folder or preview selected file": "Buka folder yang dipilih atau pratinjau file yang dipilih",
  "Step back through visited folders": "Mundur melalui folder yang telah dikunjungi",
  "Go up one level to parent folder": "Naik satu tingkat ke folder induk",
  "Select all visible files and folders": "Pilih semua file dan folder yang terlihat",
  "Clear selection, close modals, or reset search": "Hapus pilihan, tutup modal, atau reset pencarian",
  "Move selected items to trash (or purge in trash view)": "Pindahkan item terpilih ke sampah (atau hapus permanen di tampilan sampah)",
  "Toggle favorite / star on selected items": "Ganti status favorit pada item terpilih",
  "Show this keyboard shortcuts help": "Tampilkan bantuan pintasan keyboard ini",
  "Previous / next photo or video part": "Foto atau bagian video sebelumnya/berikutnya",
  "Spreadsheet": "Spreadsheet",
  "Presentation": "Presentasi",
  Code: "Kode",
  Text: "Teks",
  Image: "Gambar",
  Video: "Video",
  Subtitle: "Subtitle",
  Audio: "Audio",
  Gallery: "Galeri",
  "Large icons": "Ikon besar",
  "Medium icons": "Ikon sedang",
  "Small icons": "Ikon kecil",
  List: "Daftar",
  Tiles: "Ubin",
  Content: "Konten",
  "Today": "Hari ini",
  "Yesterday": "Kemarin",
  "This week": "Minggu ini",
  "This month": "Bulan ini",
  "Older": "Lebih lama",
  "Show parent folders": "Tampilkan folder induk",
  "Clear query": "Hapus pencarian",
  "Close search": "Tutup pencarian",
  "Search files": "Cari file",
  "All files (Home)": "Semua file (Beranda)",
  "Restore this folder": "Pulihkan folder ini",
  "Upload folder": "Unggah folder",
  "No pulls yet": "Belum ada pengambilan",
  "Success": "Berhasil",
  "Close Page": "Tutup Halaman",
  "Save to Catalog": "Simpan ke Katalog",
  "File Category": "Kategori File",
  "Previous (←)": "Sebelumnya (←)",
  "Next (→)": "Berikutnya (→)",
  "Rotate (R)": "Putar (R)",
  "Expand filmstrip (E)": "Bentangkan filmstrip (E)",
  "Collapse filmstrip (E)": "Lipat filmstrip (E)",
  "Scroll filmstrip left": "Gulir filmstrip ke kiri",
  "Scroll filmstrip right": "Gulir filmstrip ke kanan",
  "Fullscreen (F)": "Layar penuh (F)",
  "Close (Esc)": "Tutup (Esc)",
  "Update thumbnail…": "Perbarui thumbnail…",
};

const indonesianToEnglish: Record<string, string> = {
  "Terjadi kesalahan": "Something went wrong",
  "Coba lagi": "Try again",
  "Muat ulang halaman": "Reload page",
  Kembali: "Back",
  "Mulai backup": "Start backup",
  "Tambah file": "Add file",
  "Tambah folder (DCIM…)": "Add folder (DCIM…)",
  Ulangi: "Retry",
  Buang: "Discard",
  "Jeda otomatis: disk VPS menipis.": "Auto-paused: VPS disk is running low.",
  "Gagal di HP": "Failed on phone",
  "Gagal di VPS": "Failed on VPS",
  Selesai: "Done",
  menunggu: "waiting",
  antre: "queued",
  mengunggah: "uploading",
  selesai: "done",
  dibatalkan: "canceled",
  "Tidak bisa memuat data": "Could not load data",
  "Kode error:": "Error code:",
  "Koneksi mungkin terputus.": "The connection may have dropped.",
  Penyimpanan: "Storage",
  "Panel detail": "Details pane",
  "Bilah sisi": "Sidebar",
  "Tampilan ringkas": "Compact view",
  "Kotak centang item": "Item check boxes",
  "Ekstensi nama file": "File name extensions",
  "Kelompokkan versi": "Group versions",
  "Detail item": "Detail items",
  "Pilih folder di laptop": "Select a folder on the laptop",
  "Pilih file di laptop": "Select a file on the laptop",
  Naik: "Up",
  "Pilih folder ini": "Select this folder",
  "Ganti tema": "Toggle theme",
  "Unggahan selesai": "Uploads complete",
  "Lanjutkan": "Resume",
  Proses: "Process",
  "Belum ada unggahan yang selesai.": "No completed uploads yet.",
  "Tidak ada proses yang berjalan.": "Nothing in progress.",
  "Dalam antrean": "Queued",
  Gagal: "Failed",
  "Dalam antrean → Telegram": "Queued → Telegram",
  "Menunggu watcher": "Waiting for watcher",
  "Mengunggah → Telegram": "Uploading → Telegram",
  Dibatalkan: "Canceled",
  Siap: "Ready",
  "Mengunggah → VPS": "Uploading → VPS",
  "Menambahkan ke antrean": "Queuing",
  "Satu file": "single file",
  "Dipecah": "split",
  "Drive Utama": "Main Drive",
  "Ruang Pribadi": "Private Space",
  "Unggah dari perangkat ini": "Upload from this device",
  "Path host (lanjutan)": "Host path (advanced)",
  "Tambah file ke antrean": "Add file(s) to queue",
  "Tambah folder ke antrean": "Add folder to queue",
  "Telusuri…": "Browse…",
  "Tambah ke antrean": "Add to queue",
  Antrean: "Queue",
  aktif: "live",
  "Pindahkan ke sampah": "Move to trash",
  "Hapus selamanya": "Delete forever",
  "Buka kunci": "Unlock",
  "Folder baru": "New folder",
  Buat: "Create",
  "Ganti nama folder": "Rename folder",
  "Ekstrak arsip": "Unpack archive",
  "Pindahkan ke drive utama": "Move to main drive",
  "Detail folder": "Folder details",
  Subfolder: "Subfolders",
  "Isi langsung": "Direct contents",
  Dibuat: "Created",
  Diubah: "Modified",
  "Tidak ada hasil": "No results",
  "Sampah kosong": "Trash is empty",
  "Belum ada favorit": "No favorites yet",
  "Belum ada aktivitas terbaru": "No recent activity",
  "Tag ini kosong": "This tag is empty",
  "Drive kosong": "Drive is empty",
  "Navigasi & pilihan": "Navigation & selection",
  "Pencarian & aksi": "Search & actions",
  "Media & penampil pratinjau": "Media & preview viewer",
  "Fokus ke bilah pencarian": "Focus search bar",
  "Pintasan keyboard": "Keyboard shortcuts",
  Menaik: "Ascending",
  Menurun: "Descending",
  "Kelompokkan berdasarkan": "Group by",
  "Pindahkan ke…": "Move to...",
  "Tambah ke favorit": "Add to favorites",
  "Ganti status favorit": "Toggle favorite",
  "Menyimpan…": "Saving…",
  "Pilih warna": "Pick colour",
  "Klik untuk mengganti nama": "Click to rename",
  "Tidak ada": "None",
  Isi: "Contents",
  Bagian: "Parts",
  "Edit metadata": "Edit metadata",
  "Ambil ulang": "Re-fetch",
  "Ambil dari Telegram": "Fetch from Telegram",
  "Atur thumbnail…": "Set thumbnail…",
  "Pratinjau PDF": "PDF preview",
  "Sangat kecil (< 1 MB)": "Tiny (< 1 MB)",
  "Kecil (1–10 MB)": "Small (1–10 MB)",
  "Sedang (10–100 MB)": "Medium (10–100 MB)",
  "Besar (100 MB – 1 GB)": "Large (100 MB – 1 GB)",
  "Sangat besar (> 1 GB)": "Huge (> 1 GB)",
};

const originalText = new WeakMap<Node, string>();
const originalAttributes = new WeakMap<Element, Record<string, string>>();

function translate(value: string, locale: Locale) {
  const trimmed = value.trim();
  const exact = locale === "id"
    ? translations[trimmed]
    : indonesianToEnglish[trimmed] || Object.entries(translations).find(([, translated]) => translated === trimmed)?.[0];
  if (exact != null) return value.replace(trimmed, exact);

  const dynamic = (source: string) => {
    if (locale === "id") {
      return source
        .replace(/^Show (\d+) more$/, "Tampilkan $1 lagi")
        .replace(/^Show more \((\d+)\)$/, "Tampilkan lebih banyak ($1)")
        .replace(/^\+(\d+) more$/, "+$1 lagi")
        .replace(/^(\d+) item(s?) found$/, "$1 item ditemukan")
        .replace(/^(\d+) folder(s?), (\d+) item(s?)$/, "$1 folder, $3 item")
        .replace(/^(\d+) part(s?)$/, "$1 bagian")
        .replace(/^(\d+) version(s?)$/, "$1 versi")
        .replace(/^(\d+) day(s?) left$/, "tersisa $1 hari")
        .replace(/^Permanently deleted in (\d+) days$/, "Dihapus permanen dalam $1 hari")
        .replace(/^No files match "(.+)"\.$/, "Tidak ada file yang cocok dengan \"$1\".")
        .replace(/^Resume \((\d+)\)$/, "Lanjutkan ($1)")
        .replace(/^Process \((\d+)\)$/, "Proses ($1)")
        .replace(/^Completed \((\d+)\)$/, "Selesai ($1)")
        .replace(/^Ulangi (\d+) gagal$/, "Coba lagi $1 yang gagal")
        .replace(/^(\d+) parts — the real storage$/, "$1 bagian — penyimpanan sebenarnya")
        .replace(/^(\d+) media · (\d+) archives · (\d+) in trash$/, "$1 media · $2 arsip · $3 di sampah")
        .replace(/^of (.+) \((\d+)% used\)$/, "dari $1 ($2% terpakai)")
        .replace(/^(.+) used on (.+)$/, "$1 terpakai di $2")
        .replace(/^Uploading (\d+) file(s?)$/, "Mengunggah $1 file")
        .replace(/^(\d+) upload(s?) failed$/, "$1 unggahan gagal")
        .replace(/^(\d+) queued$/, "$1 dalam antrean")
        .replace(/^(\d+) done · queued to Telegram$/, "$1 selesai · diantrekan ke Telegram")
        .replace(/^Clear (\d+) completed$/, "Bersihkan $1 yang selesai");
    }
    return source
      .replace(/^Tampilkan (\d+) lagi$/, "Show $1 more")
      .replace(/^Tampilkan lebih banyak \((\d+)\)$/, "Show more ($1)")
      .replace(/^\+(\d+) lagi$/, "+$1 more")
      .replace(/^(\d+) item ditemukan$/, "$1 items found")
      .replace(/^(\d+) folder, (\d+) item$/, "$1 folders, $2 items")
      .replace(/^(\d+) bagian$/, "$1 parts")
      .replace(/^(\d+) bagian — penyimpanan sebenarnya$/, "$1 parts — the real storage")
      .replace(/^(\d+) media · (\d+) arsip · (\d+) di sampah$/, "$1 media · $2 archives · $3 in trash")
      .replace(/^dari (.+) \((\d+)% terpakai\)$/, "of $1 ($2% used)")
      .replace(/^(.+) terpakai di (.+)$/, "$1 used on $2")
      .replace(/^(\d+) versi$/, "$1 versions")
      .replace(/^tersisa (\d+) hari$/, "$1 days left")
      .replace(/^Dihapus permanen dalam (\d+) hari$/, "Permanently deleted in $1 days")
      .replace(/^Tidak ada file yang cocok dengan "(.+)"\.$/, "No files match \"$1\".")
      .replace(/^Lanjutkan \((\d+)\)$/, "Resume ($1)")
      .replace(/^Proses \((\d+)\)$/, "Process ($1)")
      .replace(/^Selesai \((\d+)\)$/, "Completed ($1)")
      .replace(/^Coba lagi (\d+) yang gagal$/, "Retry $1 failed")
      .replace(/^Mengunggah (\d+) file$/, "Uploading $1 files")
      .replace(/^(\d+) unggahan gagal$/, "$1 uploads failed")
      .replace(/^(\d+) dalam antrean$/, "$1 queued")
      .replace(/^(\d+) selesai · diantrekan ke Telegram$/, "$1 done · queued to Telegram")
      .replace(/^Bersihkan (\d+) yang selesai$/, "Clear $1 completed");
  };
  const transformed = dynamic(trimmed);
  if (transformed !== trimmed) return value.replace(trimmed, transformed);

  return value;
}

function applyTranslations(locale: Locale) {
  const root = document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || ["SCRIPT", "STYLE", "INPUT", "TEXTAREA"].includes(parent.tagName)) continue;
    const source = node.textContent || "";
    const original = originalText.get(node) || source;
    originalText.set(node, original);
    const next = translate(original, locale);
    if (node.textContent !== next) node.textContent = next;
  }
  document.querySelectorAll<HTMLElement>("[title], [aria-label], [placeholder]").forEach((el) => {
    for (const attr of ["title", "aria-label", "placeholder"]) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const originals = originalAttributes.get(el) || {};
      const original = originals[attr] || value;
      const next = translate(original, locale);
      if (value !== next) el.setAttribute(attr, next);
      originals[attr] = original;
      originalAttributes.set(el, originals);
    }
  });
}

export function LanguageToggle() {
  const [locale, setLocale] = useState<Locale>("en");
  const localeRef = useRef<Locale>("en");
  useEffect(() => {
    const saved = localStorage.getItem("tcd_locale");
    const next: Locale = saved === "id" ? "id" : "en";
    localeRef.current = next;
    setLocale(next);
    document.documentElement.lang = next;

    // Let the App Router finish hydrating server-rendered children before changing their DOM.
    // Otherwise a saved ID preference can replace English text while React is still hydrating.
    let observer: MutationObserver | null = null;
    const frame = window.requestAnimationFrame(() => {
      const afterHydration = window.requestAnimationFrame(() => {
        applyTranslations(localeRef.current);
        observer = new MutationObserver(() => applyTranslations(localeRef.current));
        observer.observe(document.body, { childList: true, subtree: true });
      });
      cleanupFrame = () => window.cancelAnimationFrame(afterHydration);
    });
    let cleanupFrame = () => {};
    return () => {
      window.cancelAnimationFrame(frame);
      cleanupFrame();
      observer?.disconnect();
    };
  }, []);

  const change = (next: Locale) => {
    localeRef.current = next;
    setLocale(next);
    localStorage.setItem("tcd_locale", next);
    document.documentElement.lang = next;
    applyTranslations(next);
  };

  return (
    <div className="locale-toggle" aria-label="Language / Bahasa">
      <button className={locale === "en" ? "active" : ""} onClick={() => change("en")}>EN</button>
      <button className={locale === "id" ? "active" : ""} onClick={() => change("id")}>ID</button>
    </div>
  );
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  return <>{children}<LanguageToggle /></>;
}
