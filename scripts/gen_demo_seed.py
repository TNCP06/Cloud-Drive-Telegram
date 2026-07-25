#!/usr/bin/env python3
"""Generate the demo dataset for the UI-only Vercel deployment.

Produces two things, both committed:

  web/public/demo/...   — the actual bytes the demo serves (videos, images, docs, …)
  web/lib/demo/seed.ts  — DEMO_SQL: bot/schema.sql verbatim + INSERTs for the dummy drive

`bot/schema.sql` is embedded at GENERATION time, so re-running this script is how the demo
schema stays in sync with the real one. Nothing reads the .sql at runtime (Vercel's file
tracing never has to find it) and nothing outside `lib/db.ts` knows the demo exists.

Requires: ffmpeg on PATH, Pillow. Run from the repo root:

    python scripts/gen_demo_seed.py
"""

from __future__ import annotations

import base64
import io
import json
import math
import random
import shutil
import struct
import subprocess
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "web" / "public" / "demo"
SEED_TS = ROOT / "web" / "lib" / "demo" / "seed.ts"
SCHEMA = ROOT / "bot" / "schema.sql"

FONT_DIR = Path("C:/Windows/Fonts")
FFMPEG_FONT = "C\\:/Windows/Fonts/arialbd.ttf"

random.seed(7)


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    for cand in (FONT_DIR / name, Path("/usr/share/fonts/truetype/dejavu") / name):
        if cand.exists():
            return ImageFont.truetype(str(cand), size)
    return ImageFont.load_default()


def run(*args: str) -> None:
    subprocess.run(args, check=True, capture_output=True)


# ---------------------------------------------------------------------------
# Image synthesis
# ---------------------------------------------------------------------------

PALETTES = {
    "mountain": ((28, 42, 84), (232, 138, 78), (250, 214, 165)),
    "city": ((10, 12, 30), (76, 44, 122), (238, 96, 122)),
    "forest": ((14, 46, 38), (54, 122, 84), (196, 214, 148)),
    "beach": ((18, 78, 112), (86, 172, 186), (244, 226, 188)),
    "aurora": ((8, 16, 40), (34, 122, 138), (146, 226, 190)),
    "deepsea": ((4, 18, 46), (14, 68, 110), (72, 154, 178)),
    "launch": ((36, 14, 38), (156, 52, 62), (240, 158, 90)),
    "drone": ((22, 32, 58), (92, 108, 148), (220, 226, 238)),
    "interview": ((30, 28, 26), (108, 92, 74), (222, 206, 176)),
    "vault": ((26, 26, 32), (70, 62, 88), (176, 164, 200)),
}


def gradient(size: tuple[int, int], palette: tuple, seed: int) -> Image.Image:
    """Vertical 3-stop gradient + a few soft blobs — reads as an abstract photo."""
    w, h = size
    top, mid, bot = palette
    img = Image.new("RGB", (1, h))
    px = img.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        if t < 0.5:
            a, b, u = top, mid, t * 2
        else:
            a, b, u = mid, bot, (t - 0.5) * 2
        px[0, y] = tuple(int(a[i] + (b[i] - a[i]) * u) for i in range(3))
    img = img.resize((w, h), Image.BILINEAR)

    rnd = random.Random(seed)
    blobs = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(blobs)
    for _ in range(7):
        r = rnd.randint(w // 8, w // 3)
        cx, cy = rnd.randint(0, w), rnd.randint(0, h)
        col = palette[rnd.randint(0, 2)]
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(*col, rnd.randint(40, 90)))
    blobs = blobs.filter(ImageFilter.GaussianBlur(w // 12))
    img = Image.alpha_composite(img.convert("RGBA"), blobs).convert("RGB")

    # Horizon line + a couple of silhouettes so it isn't a flat mesh gradient.
    d = ImageDraw.Draw(img)
    hz = int(h * 0.68)
    peaks = [(0, hz)]
    x = 0
    while x < w:
        x += rnd.randint(w // 10, w // 5)
        peaks.append((min(x, w), hz - rnd.randint(0, h // 5)))
    peaks += [(w, h), (0, h)]
    d.polygon(peaks, fill=tuple(int(c * 0.35) for c in palette[0]))
    return img


def label(img: Image.Image, title: str, sub: str) -> Image.Image:
    w, h = img.size
    d = ImageDraw.Draw(img, "RGBA")
    d.rectangle((0, int(h * 0.78), w, h), fill=(0, 0, 0, 110))
    d.text((int(w * 0.05), int(h * 0.82)), title, font=font("arialbd.ttf", max(18, w // 24)), fill=(255, 255, 255))
    d.text((int(w * 0.05), int(h * 0.90)), sub, font=font("arial.ttf", max(12, w // 42)), fill=(226, 226, 232))
    return img


def save_photo(name: str, palette_key: str, title: str, sub: str, seed: int, size=(1600, 1000)) -> None:
    img = label(gradient(size, PALETTES[palette_key], seed), title, sub)
    out = PUBLIC / name
    if name.endswith(".png"):
        img.save(out, "PNG", optimize=True)
    elif name.endswith(".webp"):
        img.save(out, "WEBP", quality=82)
    else:
        img.save(out, "JPEG", quality=82, optimize=True)


def thumb_bytes(src: Image.Image) -> str:
    """256px-wide JPEG, base64 — exactly what the bot stores in `thumbnails.data`."""
    im = src.copy()
    im.thumbnail((256, 256), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=68, optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def animated_gif(name: str) -> None:
    frames = []
    for i in range(24):
        img = Image.new("RGB", (480, 480), (18, 20, 32))
        d = ImageDraw.Draw(img)
        for k in range(8):
            ang = math.radians(i * 15 + k * 45)
            x, y = 240 + math.cos(ang) * 140, 240 + math.sin(ang) * 140
            shade = 255 - k * 26
            d.ellipse((x - 26, y - 26, x + 26, y + 26), fill=(shade, int(shade * 0.5), 90))
        frames.append(img.convert("P", palette=Image.ADAPTIVE))
    frames[0].save(PUBLIC / name, save_all=True, append_images=frames[1:], duration=60, loop=0, optimize=True)


# ---------------------------------------------------------------------------
# Video / audio synthesis (ffmpeg lavfi — no third-party footage, no licensing)
# ---------------------------------------------------------------------------


def make_video(name: str, title: str, c0: str, c1: str, seconds: int, size="1280x720") -> Path:
    out = PUBLIC / name
    text = title.replace(":", "").replace("'", "")
    run(
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i",
        f"gradients=size={size}:rate=25:duration={seconds}:c0={c0}:c1={c1}:speed=0.035",
        "-f", "lavfi", "-i", f"sine=frequency=320:duration={seconds}",
        "-vf",
        f"drawtext=fontfile='{FFMPEG_FONT}':text='{text}':fontcolor=white@0.92:fontsize=52:x=60:y=56,"
        f"drawtext=fontfile='{FFMPEG_FONT}':text='%{{pts\\:hms}}':fontcolor=white@0.85:fontsize=40:"
        f"x=60:y=h-100:box=1:boxcolor=black@0.35:boxborderw=14",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", "-shortest",
        str(out),
    )
    return out


def make_webm(src: Path, name: str, seconds: int) -> None:
    run(
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
        "-t", str(seconds), "-vf", "scale=854:480", "-c:v", "libvpx", "-b:v", "500k",
        "-deadline", "realtime", "-cpu-used", "5", "-c:a", "libvorbis", "-b:a", "64k",
        str(PUBLIC / name),
    )


def video_thumb(src: Path, at: float) -> str:
    tmp = PUBLIC / "_frame.png"
    run("ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", str(at), "-i", str(src),
        "-frames:v", "1", str(tmp))
    with Image.open(tmp) as im:
        data = thumb_bytes(im.convert("RGB"))
    tmp.unlink()
    return data


def make_audio(name: str, seconds: int, freq: int) -> None:
    args = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i",
        f"sine=frequency={freq}:duration={seconds},tremolo=f=3:d=0.6,aecho=0.8:0.9:120:0.3",
    ]
    if name.endswith(".flac"):
        args += ["-c:a", "flac", "-compression_level", "8"]
    else:
        args += ["-c:a", "libmp3lame", "-b:a", "96k"]
    run(*args, str(PUBLIC / name))


# ---------------------------------------------------------------------------
# Documents. No python-docx/openpyxl here, so the two OOXML files are hand-rolled
# with `zipfile` — minimal but genuinely valid, so mammoth/SheetJS really parse them.
# ---------------------------------------------------------------------------

CT_DOCX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

RELS_DOCX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""


def docx_paragraph(text: str, style: str | None = None) -> str:
    pr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    safe = text.replace("&", "&amp;").replace("<", "&lt;")
    return f'<w:p>{pr}<w:r><w:t xml:space="preserve">{safe}</w:t></w:r></w:p>'


def make_docx(name: str, blocks: list[tuple[str, str | None]]) -> None:
    body = "".join(docx_paragraph(t, s) for t, s in blocks)
    doc = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}</w:body></w:document>"
    )
    with zipfile.ZipFile(PUBLIC / name, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT_DOCX)
        z.writestr("_rels/.rels", RELS_DOCX)
        z.writestr("word/document.xml", doc)


CT_XLSX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"""

RELS_XLSX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

WB_XLSX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>"""

WB_RELS_XLSX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"""


def col_name(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def make_xlsx(name: str, rows: list[list]) -> None:
    """Inline strings only — avoids sharedStrings.xml and parses cleanly in SheetJS."""
    xml_rows = []
    for ri, row in enumerate(rows, start=1):
        cells = []
        for ci, val in enumerate(row):
            ref = f"{col_name(ci)}{ri}"
            if isinstance(val, (int, float)):
                cells.append(f'<c r="{ref}"><v>{val}</v></c>')
            else:
                safe = str(val).replace("&", "&amp;").replace("<", "&lt;")
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{safe}</t></is></c>')
        xml_rows.append(f'<row r="{ri}">{"".join(cells)}</row>')
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(xml_rows)}</sheetData></worksheet>'
    )
    with zipfile.ZipFile(PUBLIC / name, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT_XLSX)
        z.writestr("_rels/.rels", RELS_XLSX)
        z.writestr("xl/workbook.xml", WB_XLSX)
        z.writestr("xl/_rels/workbook.xml.rels", WB_RELS_XLSX)
        z.writestr("xl/worksheets/sheet1.xml", sheet)


def make_pdf(name: str, pages: list[tuple[str, str]]) -> None:
    """Rendered pages (PIL → PDF). Not selectable text, but it *is* a real PDF and the
    dashboard's <iframe> preview renders it exactly like a scanned report."""
    imgs = []
    for title, body in pages:
        page = Image.new("RGB", (1240, 1754), (252, 251, 248))
        d = ImageDraw.Draw(page)
        d.rectangle((0, 0, 1240, 210), fill=(28, 42, 84))
        d.text((90, 78), title, font=font("arialbd.ttf", 58), fill=(255, 255, 255))
        y = 300
        for line in body.split("\n"):
            bold = line.startswith("#")
            txt = line.lstrip("# ")
            d.text((90, y), txt, font=font("arialbd.ttf" if bold else "arial.ttf", 34 if bold else 28),
                   fill=(24, 24, 28) if bold else (68, 68, 76))
            y += 62 if bold else 46
        d.line((90, 1650, 1150, 1650), fill=(200, 198, 192), width=2)
        d.text((90, 1680), "Telegram Cloud Drive — demo document", font=font("arial.ttf", 22),
               fill=(150, 148, 142))
        imgs.append(page)
    imgs[0].save(PUBLIC / name, "PDF", save_all=True, append_images=imgs[1:], resolution=110)


def make_zip_blob(name: str, mb: float) -> None:
    """Stand-in for a stored archive part. Incompressible bytes so the size looks real."""
    payload = bytes(random.getrandbits(8) for _ in range(4096)) * int(mb * 256)
    (PUBLIC / name).write_bytes(payload)


def make_pptx(name: str) -> None:
    """Preview is 'none' for slides, so this only has to be a plausible download."""
    with zipfile.ZipFile(PUBLIC / name, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT_DOCX.replace("word/document.xml", "ppt/presentation.xml"))
        z.writestr("_rels/.rels", RELS_DOCX.replace("word/document.xml", "ppt/presentation.xml"))
        z.writestr("ppt/presentation.xml", "<presentation/>")


# ---------------------------------------------------------------------------
# Drive model
# ---------------------------------------------------------------------------

from datetime import datetime, timedelta, timezone  # noqa: E402

NOW = datetime(2026, 7, 20, 9, 30, tzinfo=timezone.utc)


def ts(days_ago: float) -> str:
    return (NOW - timedelta(days=days_ago)).strftime("%Y-%m-%d %H:%M:%S")


def slugify(title: str) -> str:
    out = "".join(c.lower() if c.isalnum() else "-" for c in title)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def q(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


MB = 1024 * 1024


class Drive:
    def __init__(self) -> None:
        self.folders: list[tuple] = []
        self.items: list[tuple] = []
        self.parts: list[tuple] = []
        self.thumbs: list[tuple] = []
        self.tags: dict[str, int] = {}
        self.tag_rows: list[tuple] = []
        self.item_tags: list[tuple] = []
        self._fid = self._iid = self._pid = self._tid = 0
        self._msg = 12000

    def folder(self, name, parent=None, private=False, created=200.0, deleted=None) -> int:
        self._fid += 1
        self.folders.append(
            (self._fid, name, parent, 1 if private else 0, ts(created), ts(created / 2), deleted)
        )
        return self._fid

    def tag(self, name: str, color: str = "") -> int:
        if name not in self.tags:
            self._tid += 1
            self.tags[name] = self._tid
            self.tag_rows.append((self._tid, name, color))
        return self.tags[name]

    def item(self, title, kind, folder, parts, tags=(), fav=False, private=False,
             added=30.0, updated=None, trashed=None) -> int:
        self._iid += 1
        iid = self._iid
        total = 0
        for n, (file_name, asset, size_mb, thumb) in enumerate(parts, start=1):
            self._pid += 1
            self._msg += 1
            size = int(size_mb * MB)
            total += size
            self.parts.append(
                (self._pid, iid, n, self._msg, file_name, size, f"/demo/{asset}", ts(added))
            )
            if thumb:
                self.thumbs.append((self._pid, "image/jpeg", thumb))
        self.items.append(
            (iid, slugify(title), title, kind, len(parts), total, 1 if fav else 0,
             1 if private else 0, ts(added), ts(updated if updated is not None else added / 3),
             ts(trashed) if trashed is not None else None, folder)
        )
        for t in tags:
            self.item_tags.append((iid, self.tag(t)))
        return iid


def build_drive(th: dict[str, str]) -> Drive:
    """The dummy library. Mirrors how the real bot stores things: media = photos/videos
    (own thumbnails, streamable), archive = everything else (docs, code, split archives)."""
    d = Drive()

    f_movies = d.folder("Movies", created=420)
    f_series = d.folder("Series", created=390)
    f_music = d.folder("Music", created=360)
    f_docs = d.folder("Documents", created=380)
    f_photos = d.folder("Photos", created=410)
    f_soft = d.folder("Software", created=300)
    f_work = d.folder("Work", created=340)
    f_invoices = d.folder("Invoices", parent=f_work, created=210)
    d.folder("Archive 2025", parent=f_docs, created=250)
    f_vault = d.folder("Vault", private=True, created=180)
    d.folder("Old Exports", created=150, deleted=ts(4))

    for name, color in (
        ("4k", "sage"), ("documentary", "ochre"), ("drone", "sky"), ("game", "plum"),
        ("music", "rose"), ("personal", "sand"), ("raw", "clay"), ("series", "moss"),
        ("software", "slate"), ("travel", "teal"), ("work", "indigo"),
    ):
        d.tag(name, color)

    # --- Videos (streamable) ------------------------------------------------
    d.item("Aurora Timelapse 4K", "media", f_movies,
           [("Aurora Timelapse 4K.mp4", "clip-aurora.mp4", 486.2, th["aurora"])],
           tags=("travel", "4k"), fav=True, added=12)
    d.item("Deep Sea Documentary", "media", f_movies,
           [("Deep Sea Documentary.mkv", "clip-deepsea.mp4", 1284.0, th["deepsea"])],
           tags=("documentary", "4k"), added=38)
    d.item("Skyline Drone Pass", "media", f_movies,
           [("Skyline Drone Pass.mp4", "clip-drone.mp4", 742.8, th["drone"])],
           tags=("drone", "4k", "travel"), fav=True, added=6)
    d.item("Product Launch Teaser", "media", f_work,
           [("Product Launch Teaser.webm", "clip-launch.webm", 96.4, th["launch"])],
           tags=("work",), added=3)
    d.item("Interview Raw Cut", "media", f_work,
           [("Interview Raw Cut.mp4", "clip-interview.mp4", 2140.5, th["interview"])],
           tags=("work", "raw"), added=21)
    d.item("Nebula S01E01", "media", f_series,
           [("Nebula S01E01.mp4", "clip-aurora.mp4", 812.0, th["aurora"])],
           tags=("series",), added=55)
    d.item("Nebula S01E02", "media", f_series,
           [("Nebula S01E02.mp4", "clip-drone.mp4", 798.3, th["drone"])],
           tags=("series",), added=48)

    # --- Photos -------------------------------------------------------------
    d.item("Mountain Sunrise", "media", f_photos,
           [("Mountain Sunrise.jpg", "photo-mountain.jpg", 4.8, th["mountain"])],
           tags=("travel", "personal"), fav=True, added=64)
    d.item("City Night", "media", f_photos,
           [("City Night.png", "photo-city.png", 9.1, th["city"])],
           tags=("personal",), added=71)
    d.item("Forest Path", "media", f_photos,
           [("Forest Path.webp", "photo-forest.webp", 2.3, th["forest"])],
           tags=("travel",), added=90)
    d.item("Loading Spinner", "media", f_photos,
           [("Loading Spinner.gif", "spinner.gif", 1.4, th["spinner"])],
           tags=("work",), added=110)
    # Album = one item, many parts — the multi-part gallery case.
    d.item("Beach Trip", "media", f_photos,
           [(f"Beach Trip {i}.jpg", f"beach-0{i}.jpg", 5.2 + i, th[f"beach{i}"]) for i in (1, 2, 3, 4)],
           tags=("travel", "personal"), added=140)

    # --- Audio --------------------------------------------------------------
    d.item("Lo-Fi Study Beat", "media", f_music,
           [("Lo-Fi Study Beat.mp3", "audio-lofi.mp3", 7.6, None)], tags=("music",), added=25)
    d.item("Podcast Ep. 12", "media", f_music,
           [("Podcast Ep 12.mp3", "audio-podcast.mp3", 48.9, None)], tags=("music",), added=17)
    d.item("Master Take", "media", f_music,
           [("Master Take.flac", "audio-master.flac", 214.0, None)], tags=("music", "raw"), added=33)

    # --- Documents / code (kind = archive: everything the bot doesn't call media) ---
    d.item("Annual Report 2025", "archive", f_docs,
           [("Annual Report 2025.pdf", "report-2025.pdf", 3.4, None)], tags=("work",), fav=True, added=45)
    d.item("Project Proposal", "archive", f_work,
           [("Project Proposal.docx", "proposal.docx", 0.8, None)], tags=("work",), added=9)
    d.item("Budget Tracker", "archive", f_invoices,
           [("Budget Tracker.xlsx", "budget.xlsx", 0.3, None)], tags=("work",), added=14)
    d.item("Sales Data Q3", "archive", f_invoices,
           [("Sales Data Q3.csv", "sales-q3.csv", 0.1, None)], tags=("work",), added=15)
    d.item("Pitch Deck", "archive", f_work,
           [("Pitch Deck.pptx", "pitch.pptx", 12.7, None)], tags=("work",), added=28)
    d.item("Release Notes", "archive", f_docs,
           [("Release Notes.md", "release-notes.md", 0.02, None)], tags=("work",), added=2)
    d.item("Server Log 2026-07", "archive", f_docs,
           [("server.log", "server.log", 1.9, None)], added=1)
    d.item("Reading List", "archive", f_docs,
           [("Reading List.txt", "notes.txt", 0.01, None)], tags=("personal",), added=76)
    d.item("Database Schema", "archive", f_soft,
           [("schema-dump.sql", "schema-dump.sql", 0.06, None)], tags=("software",), added=19)
    d.item("API Client", "archive", f_soft,
           [("api-client.ts", "api-client.ts", 0.03, None)], tags=("software",), added=23)
    d.item("Model Trainer", "archive", f_soft,
           [("train_model.py", "train_model.py", 0.04, None)], tags=("software",), added=31)
    d.item("Package Manifest", "archive", f_soft,
           [("package.json", "package-sample.json", 0.01, None)], tags=("software",), added=31)
    d.item("Nebula S01E01 Subtitle", "archive", f_series,
           [("nebula-s01e01.srt", "nebula-s01e01.srt", 0.05, None)], tags=("series",), added=54)

    # --- Split archives (multi-part, download-only) + version grouping ------
    d.item("Stellar Odyssey v1.4", "archive", f_soft,
           [(f"Stellar Odyssey v1.4.7z.{n:03d}", "blob.bin", 1500.0, None) for n in range(1, 6)],
           tags=("game",), fav=True, added=8)
    d.item("Stellar Odyssey v1.2", "archive", f_soft,
           [(f"Stellar Odyssey v1.2.7z.{n:03d}", "blob.bin", 1500.0, None) for n in range(1, 5)],
           tags=("game",), added=95)
    d.item("Photoshop CC 2026", "archive", f_soft,
           [(f"Photoshop CC 2026.part{n}.rar", "blob.bin", 1200.0, None) for n in range(1, 4)],
           tags=("software",), added=62)
    d.item("Project Backup 2026-07", "archive", None,
           [("Project Backup 2026-07.zip", "blob.bin", 640.0, None)], added=5)

    # --- Trash (soft-deleted; the bot hard-deletes from Telegram after 7 days) ---
    d.item("Old Promo Cut", "media", f_work,
           [("Old Promo Cut.mp4", "clip-interview.mp4", 320.0, th["interview"])],
           tags=("work",), added=180, trashed=3)
    d.item("Draft Invoice", "archive", f_invoices,
           [("Draft Invoice.pdf", "report-2025.pdf", 0.9, None)], added=120, trashed=1)

    # --- Private space (PIN-gated) -----------------------------------------
    d.item("Passport Scan", "media", f_vault,
           [("Passport Scan.jpg", "vault-01.jpg", 3.1, th["vault1"])], private=True, added=200)
    d.item("Family Archive", "media", f_vault,
           [("Family Archive.jpg", "vault-02.jpg", 6.7, th["vault2"])],
           tags=("personal",), private=True, added=160)
    d.item("Contracts 2026", "archive", f_vault,
           [("Contracts 2026.pdf", "report-2025.pdf", 2.2, None)], private=True, added=40)

    return d


def queue_sql() -> list[str]:
    """Rows for the queue-backed pages (/upload, /stats) so they look alive, not empty."""
    ups = [
        (1, "media", "Skyline Drone Pass", "drone, 4k", "/staging/skyline.mp4", 1500, "upload", 1,
         1, 742 * MB, "done", 100, None, ts(6), ts(6)),
        (2, "archive", "Stellar Odyssey v1.4", "game", "/staging/stellar-14.7z", 1500, "upload", 1,
         5, 7500 * MB, "done", 100, None, ts(8), ts(8)),
        (3, "media", "Interview Raw Cut", "work, raw", "/staging/interview.mp4", 1500, "upload", 1,
         1, 2140 * MB, "running", 62, "Uploading part 1/1 - 1.3 GB / 2.1 GB", ts(0.02), ts(0.001)),
        (4, "archive", "Site Backup 2026-07", "", "/staging/site-backup.zip", 1500, "local", 0,
         0, 4200 * MB, "queued", 0, None, ts(0.01), ts(0.01)),
        (5, "media", "Old Promo Cut", "work", "/staging/promo.mp4", 1500, "upload", 1,
         0, 320 * MB, "error", 0, "Telegram: file too large for this account", ts(2), ts(2)),
    ]
    dls = [
        (1, "pikpak", "Movies/Aurora Timelapse 4K.mp4", "Aurora Timelapse 4K.mp4", 486 * MB,
         "done", 100, None, 486 * MB, None, ts(12), ts(12)),
        (2, "pikpak", "Series/Nebula S01E02.mp4", "Nebula S01E02.mp4", 798 * MB,
         "done", 100, None, 798 * MB, None, ts(48), ts(48)),
        (3, "pikpak", "Games/Stellar Odyssey v1.4.7z", "Stellar Odyssey v1.4.7z", 7500 * MB,
         "downloading", 41, "5.12MB/s ETA 14m", 3075 * MB, None, ts(0.01), ts(0.001)),
        (4, "pikpak", "Movies/Deep Sea Documentary.mkv", "Deep Sea Documentary.mkv", 1284 * MB,
         "failed", 8, None, 102 * MB, "rclone: directory not found", ts(30), ts(30)),
    ]
    unp = [(1, 30, None, "done", 100, "Extracted 4 files", ts(60), ts(60))]

    out = []
    for r in ups:
        out.append(
            "INSERT INTO upload_jobs (id,kind,title,tags,source_path,part_size,origin,"
            "cleanup_source,parts_done,total_bytes,status,progress,message,created_at,updated_at) "
            f"VALUES ({','.join(q(v) for v in r)});"
        )
    for r in dls:
        out.append(
            "INSERT INTO download_jobs (id,source,remote_path,filename,size,status,progress,"
            "speed,bytes_done,error,created_at,updated_at) "
            f"VALUES ({','.join(q(v) for v in r)});"
        )
    for r in unp:
        out.append(
            "INSERT INTO unpack_jobs (id,item_id,password,status,progress,message,created_at,updated_at) "
            f"VALUES ({','.join(q(v) for v in r)});"
        )
    return out


def emit(d: Drive) -> str:
    rows: list[str] = []

    def ins(table: str, cols: str, data: list[tuple]) -> None:
        for r in data:
            rows.append(f"INSERT INTO {table} ({cols}) VALUES ({','.join(q(v) for v in r)});")

    ins("folders", "id,name,parent_id,is_private,created_at,updated_at,deleted_at", d.folders)
    ins("tags", "id,name,color", d.tag_rows)
    ins("items", "id,slug,title,kind,total_parts,total_size,is_favorite,is_private,"
                 "date_added,updated_at,deleted_at,folder_id", d.items)
    ins("parts", "id,item_id,part_number,channel_msg_id,file_name,file_size,file_id,uploaded_at",
        d.parts)
    ins("item_tags", "item_id,tag_id", d.item_tags)
    ins("thumbnails", "part_id,mime,data", d.thumbs)
    rows += queue_sql()
    rows.append("INSERT INTO bot_settings (key,value) VALUES ('web_url','https://demo.local');")

    # Explicit ids above leave every IDENTITY sequence at 1 - without this, the first
    # rename/upload/new-folder in the demo collides with a seeded row.
    for t in ("folders", "items", "parts", "tags", "upload_jobs", "download_jobs", "unpack_jobs", "jobs"):
        rows.append(
            f"SELECT setval(pg_get_serial_sequence('{t}','id'), "
            f"coalesce((SELECT max(id) FROM {t}), 1));"
        )
    return "\n".join(rows)


def write_seed(sql: str) -> None:
    schema = SCHEMA.read_text(encoding="utf-8")
    body = schema + "\n\n-- ==== demo data ====\n" + sql + "\n"
    esc = body.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
    SEED_TS.parent.mkdir(parents=True, exist_ok=True)
    SEED_TS.write_text(
        "// GENERATED by scripts/gen_demo_seed.py - do not edit by hand.\n"
        "// bot/schema.sql (verbatim) + the dummy drive it is seeded with. Loaded ONLY when\n"
        "// DEMO_MODE=1, into an in-memory PGlite database (see lib/db.ts). Re-run the script\n"
        "// to resync with the real schema.\n"
        "export const DEMO_SQL = `" + esc + "`;\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------


def build_assets() -> dict[str, str]:
    """Write every byte the demo serves; return part-thumbnail base64 keyed by name."""
    if PUBLIC.exists():
        shutil.rmtree(PUBLIC)
    PUBLIC.mkdir(parents=True)
    th: dict[str, str] = {}

    clips = [
        ("clip-aurora.mp4", "Aurora Timelapse 4K", "0x0a1830", "0x2e8f8a", 30, "aurora"),
        ("clip-deepsea.mp4", "Deep Sea Documentary", "0x04122e", "0x1a6e94", 30, "deepsea"),
        ("clip-drone.mp4", "Skyline Drone Pass", "0x16203a", "0x9aa8c4", 30, "drone"),
        ("clip-interview.mp4", "Interview Raw Cut", "0x1e1c1a", "0x8c7454", 28, "interview"),
    ]
    for name, title, c0, c1, secs, key in clips:
        print(f"  video {name}")
        path = make_video(name, title, c0, c1, secs)
        th[key] = video_thumb(path, secs * 0.35)

    print("  video clip-launch.webm")
    tmp = make_video("_launch.mp4", "Product Launch Teaser", "0x240e26", "0xf09e5a", 20)
    make_webm(tmp, "clip-launch.webm", 20)
    th["launch"] = video_thumb(tmp, 7)
    tmp.unlink()

    photos = [
        ("photo-mountain.jpg", "mountain", "Mountain Sunrise", "Alpine ridge 06:14", 11, "mountain"),
        ("photo-city.png", "city", "City Night", "Rooftop ISO 800", 22, "city"),
        ("photo-forest.webp", "forest", "Forest Path", "Morning fog 35mm", 33, "forest"),
        ("vault-01.jpg", "vault", "Passport Scan", "Private document", 44, "vault1"),
        ("vault-02.jpg", "vault", "Family Archive", "Private 1998", 55, "vault2"),
    ]
    for name, pal, title, sub, seed, key in photos:
        print(f"  photo {name}")
        save_photo(name, pal, title, sub, seed)
        with Image.open(PUBLIC / name) as im:
            th[key] = thumb_bytes(im.convert("RGB"))

    for i in (1, 2, 3, 4):
        name = f"beach-0{i}.jpg"
        print(f"  photo {name}")
        save_photo(name, "beach", "Beach Trip", f"Frame {i} of 4", 70 + i)
        with Image.open(PUBLIC / name) as im:
            th[f"beach{i}"] = thumb_bytes(im.convert("RGB"))

    print("  photo spinner.gif")
    animated_gif("spinner.gif")
    with Image.open(PUBLIC / "spinner.gif") as im:
        th["spinner"] = thumb_bytes(im.convert("RGB"))

    print("  audio")
    make_audio("audio-lofi.mp3", 20, 220)
    make_audio("audio-podcast.mp3", 25, 180)
    make_audio("audio-master.flac", 12, 440)

    print("  documents")
    make_pdf("report-2025.pdf", [
        ("Annual Report 2025", "# Executive summary\nRevenue grew 34% year over year, driven by\n"
         "the storage tier launched in Q2.\n\n# Highlights\n- 1.2 PB stored across 480k objects\n"
         "- Median retrieval latency down to 180 ms\n- Two regions added (SG, FRA)\n\n"
         "# Outlook\nWe expect the next fiscal year to focus on\ncold-storage economics."),
        ("Financials", "# Revenue by quarter\nQ1  1.82 M\nQ2  2.14 M\nQ3  2.48 M\nQ4  2.91 M\n\n"
         "# Cost of goods\nBandwidth remains the single largest line\nitem at 41% of COGS."),
    ])
    make_docx("proposal.docx", [
        ("Project Proposal", None),
        ("Prepared for the platform team - July 2026", None),
        ("Background", None),
        ("The current upload pipeline serializes every part, so a 7 GB archive takes "
         "roughly 40 minutes end to end. Parallelising part uploads should cut that by half.", None),
        ("Scope", None),
        ("1. Parallel part upload with a bounded worker pool.", None),
        ("2. Resumable checkpoints per part rather than per job.", None),
        ("3. A progress channel the dashboard can subscribe to.", None),
        ("Timeline", None),
        ("Three sprints, starting the week of 3 August 2026.", None),
    ])
    make_xlsx("budget.xlsx", [
        ["Category", "Q1", "Q2", "Q3", "Q4"],
        ["Storage", 4200, 4610, 5180, 5720],
        ["Bandwidth", 8100, 8940, 10250, 11800],
        ["Compute", 2300, 2410, 2600, 2880],
        ["Licenses", 1200, 1200, 1200, 1200],
        ["Total", 15800, 17160, 19230, 21600],
    ])
    (PUBLIC / "sales-q3.csv").write_text(
        "region,rep,deals,revenue,margin\n"
        "APAC,Wira,18,142500,0.34\n"
        "APAC,Sari,12,98200,0.29\n"
        "EMEA,Lukas,21,181300,0.38\n"
        "EMEA,Nadia,9,74800,0.31\n"
        "AMER,Diego,27,246900,0.41\n"
        "AMER,Priya,15,131600,0.36\n",
        encoding="utf-8",
    )
    make_pptx("pitch.pptx")
    (PUBLIC / "release-notes.md").write_text(
        "# Release notes\n\n## 2026-07-18\n\n- Video segments now start playing while the "
        "original is still downloading.\n- Oversized videos are cut into playable segments "
        "instead of raw-split.\n- Removed the kept-on-server staging path.\n\n## 2026-06-30\n\n"
        "- Daily database backup, indexed under Backup/CDT DB.\n- Seek previews generated "
        "on first play.\n",
        encoding="utf-8",
    )
    (PUBLIC / "server.log").write_text(
        "".join(
            f"2026-07-{19 + i // 400:02d} 0{i % 10}:{i % 60:02d}:{(i * 7) % 60:02d} "
            f"{'INFO ' if i % 9 else 'WARN '} watcher  part {i % 5 + 1}/5 uploaded "
            f"({(i * 37) % 1500} MB/s)\n"
            for i in range(600)
        ),
        encoding="utf-8",
    )
    (PUBLIC / "notes.txt").write_text(
        "Reading list\n============\n\n- Designing Data-Intensive Applications\n"
        "- The Manager's Path\n- Site Reliability Engineering\n- A Philosophy of Software Design\n",
        encoding="utf-8",
    )
    (PUBLIC / "schema-dump.sql").write_text(
        "-- excerpt of the drive schema\nCREATE TABLE items (\n"
        "    id          BIGINT PRIMARY KEY,\n    slug        TEXT UNIQUE NOT NULL,\n"
        "    title       TEXT NOT NULL,\n    kind        TEXT NOT NULL,\n"
        "    total_parts INTEGER NOT NULL DEFAULT 0,\n    total_size  BIGINT NOT NULL DEFAULT 0\n);\n\n"
        "CREATE INDEX idx_items_kind ON items(kind);\n",
        encoding="utf-8",
    )
    (PUBLIC / "api-client.ts").write_text(
        'export interface DriveFile {\n  id: number;\n  slug: string;\n  name: string;\n'
        '  kind: "archive" | "media";\n  size: number;\n}\n\n'
        'export async function listFiles(space = "main"): Promise<DriveFile[]> {\n'
        '  const res = await fetch("/api/files?space=" + space);\n'
        '  if (!res.ok) throw new Error("list failed: " + res.status);\n'
        '  return res.json();\n}\n',
        encoding="utf-8",
    )
    (PUBLIC / "train_model.py").write_text(
        "import torch\nfrom torch import nn\n\n\nclass TinyNet(nn.Module):\n"
        "    def __init__(self, width: int = 128):\n        super().__init__()\n"
        "        self.net = nn.Sequential(\n            nn.Linear(784, width),\n"
        "            nn.ReLU(),\n            nn.Linear(width, 10),\n        )\n\n"
        "    def forward(self, x):\n        return self.net(x.flatten(1))\n",
        encoding="utf-8",
    )
    (PUBLIC / "package-sample.json").write_text(
        json.dumps(
            {"name": "cloud-drive-web", "private": True, "version": "1.4.0",
             "scripts": {"dev": "next dev", "build": "next build", "start": "next start"},
             "dependencies": {"next": "15.5.0", "react": "19.1.0", "pg": "8.13.1"}},
            indent=2,
        ),
        encoding="utf-8",
    )
    (PUBLIC / "nebula-s01e01.srt").write_text(
        "1\n00:00:02,120 --> 00:00:05,400\nThe signal came from beyond the rim.\n\n"
        "2\n00:00:05,900 --> 00:00:09,300\nNobody had listened on that band in forty years.\n\n"
        "3\n00:00:10,000 --> 00:00:13,750\nAnd yet, there it was - repeating.\n",
        encoding="utf-8",
    )

    print("  archive blob")
    make_zip_blob("blob.bin", 0.6)
    return th


def main() -> None:
    print("assets ->", PUBLIC)
    th = build_assets()
    print("seed   ->", SEED_TS)
    write_seed(emit(build_drive(th)))
    total = sum(p.stat().st_size for p in PUBLIC.rglob("*") if p.is_file())
    print(f"done - {total / MB:.1f} MB of assets, seed {SEED_TS.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
