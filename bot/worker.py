"""
Telegram Cloud Drive — upload worker (Telethon / MTProto).

Milestone 3: run from the laptop to upload large files.
- archive : split folder/archive with 7-Zip (~1.5 GB/part, store mode) then send each
         part to the channel as a document, with the caption contract
         "Title | part/total | tag1, tag2".
- media: send 1 file whole as media (not a document) so Telegram generates a
         thumbnail automatically (harvested later by the bot), caption "Title | 1/1 | tag".

Why Telethon (user session) instead of the bot: Bot API is limited to 50 MB uploads;
MTProto (user) supports ~2 GB/file. The bot still indexes via the channel_post handler.

Examples (PowerShell):
  python worker.py archive "D:\Games\Eternum" --title "Eternum" --tags "rpg, fantasy"
  python worker.py archive "D:\Games\Eternum.7z.001" --title "Eternum" --tags "rpg" --skip-split
  python worker.py media "D:\Videos\trailer.mp4" --title "Trailer Eternum" --tags "video, promo"

First login will prompt for phone number + code (interactive in the terminal).
Session is saved as worker.session (DO NOT commit — already in .gitignore).
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
# Helpers
# ---------------------------------------------------------------------------
def normalize_tags(raw: str | None) -> str:
    """'rpg ,  fantasy' -> 'rpg, fantasy' (ready-to-use string for the caption)."""
    if not raw:
        return ""
    return ", ".join(t.strip() for t in raw.split(",") if t.strip())


def build_caption(title: str, idx: int, total: int, tags: str) -> str:
    """Caption contract: 'Title | part/total | tag1, tag2'."""
    return f"{title} | {idx}/{total} | {tags}"


def safe_name(title: str) -> str:
    """Safe archive name derived from the title."""
    name = re.sub(r"[^\w\-. ]", "", title).strip().replace(" ", "_")
    return name or "archive"


def split_with_7zip(input_path: str, out_dir: str, title: str, part_mb: int, sevenzip: str) -> list[str]:
    """Run 7-Zip split (store mode) → return sorted list of part paths."""
    os.makedirs(out_dir, exist_ok=True)
    archive = os.path.join(out_dir, f"{safe_name(title)}.7z")
    cmd = [sevenzip, "a", f"-v{part_mb}m", "-mx=0", "-y", archive, input_path]
    print(f"→ Split: {' '.join(cmd)}")
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        sys.exit(
            f"ERROR: '{sevenzip}' not found. Install 7-Zip or use "
            f"--sevenzip \"C:\\Program Files\\7-Zip\\7z.exe\"."
        )
    except subprocess.CalledProcessError as e:
        sys.exit(f"ERROR: 7-Zip failed (exit {e.returncode}).")
    return collect_parts(archive)


def collect_parts(path: str) -> list[str]:
    """Collect sorted split parts from a path (file .001/.7z, or directory)."""
    if os.path.isdir(path):
        parts = glob.glob(os.path.join(path, "*.7z.*")) or glob.glob(os.path.join(path, "*.0*"))
    else:
        # path may be "name.7z.001" or "name.7z" → grab all "name.7z.*"
        base = re.sub(r"\.\d{3}$", "", path)  # strip .001 suffix
        parts = glob.glob(base + ".*")
        if not parts and os.path.isfile(path):
            parts = [path]
    # sort numerically by trailing digit suffix
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
        sys.exit("ERROR: no files to upload.")
    print(f"→ Uploading {total} part(s) to channel {STORAGE_CHANNEL_ID}")
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
    print("Done. The bot will index via the channel_post handler.")


async def run(args):
    tags = normalize_tags(args.tags)
    title = args.title.strip()
    did_split = False  # only files WE split may be deleted

    if args.command == "media":
        if not os.path.isfile(args.input):
            sys.exit(f"ERROR: media file not found: {args.input}")
        paths = [args.input]
        as_document = False
    else:  # archive
        if args.skip_split:
            paths = collect_parts(args.input)
            if not paths:
                sys.exit(f"ERROR: no split parts found at: {args.input}")
        else:
            if not os.path.exists(args.input):
                sys.exit(f"ERROR: input not found: {args.input}")
            out_dir = args.out or os.path.join(
                os.path.dirname(os.path.abspath(args.input)), "_upload_parts"
            )
            paths = split_with_7zip(args.input, out_dir, title, args.part_size, args.sevenzip)
            did_split = True
        as_document = True

    async with TelegramClient(SESSION, API_ID, API_HASH) as client:
        channel = await client.get_entity(STORAGE_CHANNEL_ID)
        await upload_parts(client, channel, paths, title, tags, as_document)

    # Delete split files we created (except --keep). The original media file and
    # --skip-split parts provided by the user are never touched.
    if did_split and not args.keep:
        removed = 0
        for p in paths:
            try:
                os.remove(p)
                removed += 1
            except OSError:
                pass
        print(f"Cleanup: {removed} split file(s) deleted from {os.path.dirname(paths[0])}")


def main():
    p = argparse.ArgumentParser(description="Telegram Cloud Drive — upload worker (Telethon).")
    sub = p.add_subparsers(dest="command", required=True)

    g = sub.add_parser("archive", help="Split (7-Zip) + upload multi-part archive.")
    g.add_argument("input", help="Archive folder/file, or path to .001 part if using --skip-split.")
    g.add_argument("--title", required=True, help="Item title.")
    g.add_argument("--tags", default="", help='Comma-separated tags, e.g. "rpg, fantasy".')
    g.add_argument("--part-size", type=int, default=1500, help="Size of each part (MB). Default 1500.")
    g.add_argument("--out", help="Output folder for parts. Default: _upload_parts next to input.")
    g.add_argument("--skip-split", action="store_true", help="Input is already split, upload directly.")
    g.add_argument("--sevenzip", default="7z", help="Path to 7z.exe if not in PATH.")
    g.add_argument("--keep", action="store_true", help="Keep split files after a successful upload.")

    m = sub.add_parser("media", help="Upload a single media file (video/image).")
    m.add_argument("input", help="Path to the media file.")
    m.add_argument("--title", required=True, help="Item title.")
    m.add_argument("--tags", default="", help='Comma-separated tags, e.g. "video, promo".')

    args = p.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
