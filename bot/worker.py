"""
Telegram Cloud Drive — worker upload (Telethon / MTProto).

Milestone 3: dijalankan dari laptop untuk upload file besar.
- game : split folder/arsip dengan 7-Zip (~1.5 GB/part, mode store) lalu kirim tiap
         part ke channel sebagai dokumen, dengan caption kontrak
         "Judul | part/total | tag1, tag2".
- media: kirim 1 file utuh sebagai media (bukan dokumen) supaya Telegram membuat
         thumbnail otomatis (nanti di-harvest bot), caption "Judul | 1/1 | tag".

Kenapa Telethon (user session), bukan bot: Bot API dibatasi 50 MB upload; MTProto
(user) sampai ~2 GB/file. Bot tetap yang meng-index lewat handler channel_post.

Contoh (PowerShell):
  python worker.py game "D:\Games\Eternum" --title "Eternum" --tags "rpg, fantasy"
  python worker.py game "D:\Games\Eternum.7z.001" --title "Eternum" --tags "rpg" --skip-split
  python worker.py media "D:\Videos\trailer.mp4" --title "Trailer Eternum" --tags "video, promo"

Login pertama kali akan meminta nomor telepon + kode (interaktif di terminal laptop).
Session tersimpan sebagai worker.session (JANGAN commit — sudah di .gitignore).
"""

import argparse
import asyncio
import glob
import os
import re
import subprocess
import sys

from dotenv import load_dotenv
from telethon import TelegramClient

load_dotenv()  # bot/.env

API_ID = int(os.environ["TG_API_ID"])
API_HASH = os.environ["TG_API_HASH"]
STORAGE_CHANNEL_ID = int(os.environ["STORAGE_CHANNEL_ID"])
SESSION = os.environ.get("WORKER_SESSION", "worker")


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------
def normalize_tags(raw: str | None) -> str:
    """'rpg ,  fantasy' -> 'rpg, fantasy' (string siap dipakai di caption)."""
    if not raw:
        return ""
    return ", ".join(t.strip() for t in raw.split(",") if t.strip())


def build_caption(title: str, idx: int, total: int, tags: str) -> str:
    """Format kontrak: 'Judul | part/total | tag1, tag2'."""
    return f"{title} | {idx}/{total} | {tags}"


def safe_name(title: str) -> str:
    """Nama arsip aman dari judul."""
    name = re.sub(r"[^\w\-. ]", "", title).strip().replace(" ", "_")
    return name or "archive"


def split_with_7zip(input_path: str, out_dir: str, title: str, part_mb: int, sevenzip: str) -> list[str]:
    """Jalankan 7-Zip split (store mode) -> kembalikan daftar path part terurut."""
    os.makedirs(out_dir, exist_ok=True)
    archive = os.path.join(out_dir, f"{safe_name(title)}.7z")
    cmd = [sevenzip, "a", f"-v{part_mb}m", "-mx=0", "-y", archive, input_path]
    print(f"→ Split: {' '.join(cmd)}")
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        sys.exit(
            f"ERROR: '{sevenzip}' tidak ditemukan. Install 7-Zip atau pakai "
            f"--sevenzip \"C:\\Program Files\\7-Zip\\7z.exe\"."
        )
    except subprocess.CalledProcessError as e:
        sys.exit(f"ERROR: 7-Zip gagal (exit {e.returncode}).")
    return collect_parts(archive)


def collect_parts(path: str) -> list[str]:
    """Kumpulkan part split terurut dari sebuah path (file .001/.7z, atau folder)."""
    if os.path.isdir(path):
        parts = glob.glob(os.path.join(path, "*.7z.*")) or glob.glob(os.path.join(path, "*.0*"))
    else:
        # path bisa "name.7z.001" atau "name.7z" -> ambil semua "name.7z.*"
        base = re.sub(r"\.\d{3}$", "", path)  # buang sufiks .001
        parts = glob.glob(base + ".*")
        if not parts and os.path.isfile(path):
            parts = [path]
    # urutkan numerik berdasarkan sufiks angka
    def key(p):
        m = re.search(r"\.(\d+)$", p)
        return int(m.group(1)) if m else 0
    return sorted((p for p in parts if os.path.isfile(p)), key=key)


def make_progress(name: str):
    last = [-1]
    def cb(sent: int, total: int):
        pct = int(sent * 100 / total) if total else 0
        if pct != last[0]:
            last[0] = pct
            print(f"\r  {name}: {pct}%", end="", flush=True)
    return cb


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------
async def upload_parts(client, channel, paths: list[str], title: str, tags: str, as_document: bool):
    total = len(paths)
    if total == 0:
        sys.exit("ERROR: tidak ada file untuk diunggah.")
    print(f"→ Mengunggah {total} part ke channel {STORAGE_CHANNEL_ID}")
    for i, path in enumerate(paths, start=1):
        caption = build_caption(title, i, total, tags)
        name = os.path.basename(path)
        await client.send_file(
            channel,
            path,
            caption=caption,
            force_document=as_document,
            supports_streaming=not as_document,
            progress_callback=make_progress(f"[{i}/{total}] {name}"),
        )
        print(f"  ✓ {name} — \"{caption}\"")
    print("Selesai. Bot akan meng-index lewat handler channel_post.")


async def run(args):
    tags = normalize_tags(args.tags)
    title = args.title.strip()
    did_split = False  # hanya file yang KITA split yang boleh dihapus

    if args.command == "media":
        if not os.path.isfile(args.input):
            sys.exit(f"ERROR: file media tidak ditemukan: {args.input}")
        paths = [args.input]
        as_document = False
    else:  # game
        if args.skip_split:
            paths = collect_parts(args.input)
            if not paths:
                sys.exit(f"ERROR: tidak menemukan part split di: {args.input}")
        else:
            if not os.path.exists(args.input):
                sys.exit(f"ERROR: input tidak ditemukan: {args.input}")
            out_dir = args.out or os.path.join(
                os.path.dirname(os.path.abspath(args.input)), "_upload_parts"
            )
            paths = split_with_7zip(args.input, out_dir, title, args.part_size, args.sevenzip)
            did_split = True
        as_document = True

    async with TelegramClient(SESSION, API_ID, API_HASH) as client:
        channel = await client.get_entity(STORAGE_CHANNEL_ID)
        await upload_parts(client, channel, paths, title, tags, as_document)

    # Hapus file split yang kita buat (kecuali --keep). File media asli & part
    # --skip-split milik user tidak disentuh.
    if did_split and not args.keep:
        removed = 0
        for p in paths:
            try:
                os.remove(p)
                removed += 1
            except OSError:
                pass
        print(f"Cleanup: {removed} file split dihapus dari {os.path.dirname(paths[0])}")


def main():
    p = argparse.ArgumentParser(description="Telegram Cloud Drive — worker upload (Telethon).")
    sub = p.add_subparsers(dest="command", required=True)

    g = sub.add_parser("game", help="Split (7-Zip) + upload arsip game multi-part.")
    g.add_argument("input", help="Folder/arsip game, atau path part .001 bila --skip-split.")
    g.add_argument("--title", required=True, help="Judul item.")
    g.add_argument("--tags", default="", help='Tag dipisah koma, mis. "rpg, fantasy".')
    g.add_argument("--part-size", type=int, default=1500, help="Ukuran tiap part (MB). Default 1500.")
    g.add_argument("--out", help="Folder output part. Default: _upload_parts di samping input.")
    g.add_argument("--skip-split", action="store_true", help="Input sudah ter-split, langsung upload.")
    g.add_argument("--sevenzip", default="7z", help="Path 7z.exe bila tidak ada di PATH.")
    g.add_argument("--keep", action="store_true", help="Jangan hapus file split setelah upload sukses.")

    m = sub.add_parser("media", help="Upload 1 file media (video/gambar) utuh.")
    m.add_argument("input", help="Path file media.")
    m.add_argument("--title", required=True, help="Judul item.")
    m.add_argument("--tags", default="", help='Tag dipisah koma, mis. "video, promo".')

    args = p.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
