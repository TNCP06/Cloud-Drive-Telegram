"""Streamtape & Gofile URL extractors and HTTP streaming download worker for Cloud-Drive-Telegram.

Allows authorized users to download videos and files directly from Streamtape, Gofile.io,
and generic HTTP direct links into the Telegram cloud storage without requiring manual downloads.
"""

import asyncio
import hashlib
import html
import os
import re
import shutil
import time
from typing import List, Tuple, Optional
from urllib.parse import urlparse, parse_qs

import httpx
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, ForceReply

from bot_config import (
    PIKPAK_MAX_BYTES,
    PIKPAK_STAGING_DIR,
    DRIVE_SPLIT_PART_MB,
    log,
)
from db_ops import is_user_authorized
from tg_helpers import human_size, format_eta as _fmt_eta, MEDIA_EXTS as _MEDIA_EXTS

# Constants
STREAMTAPE_DOMAINS = (
    "streamtape.com",
    "streamta.pe",
    "streamtape.to",
    "streamtape.net",
    "streamtape.xyz",
    "streamta.site",
    "adblockstreamtape.com",
    "streamadblocker.com",
)

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
GOFILE_LANG = "en-US"
GOFILE_FALLBACK_SALT = "12af056dacea0b"

POLL_INTERVAL = 3
EDIT_THROTTLE_S = 6
DB_THROTTLE_S = 5
STALL_WINDOW_S = int(os.environ.get("DRIVE_STALL_WINDOW_S", str(3 * 3600)))
STALL_MIN_BYTES = int(os.environ.get("DRIVE_STALL_MIN_MB", "20")) * 1048576
MAX_DL_SECONDS = int(os.environ.get("DRIVE_MAX_DL_SECONDS", str(7 * 24 * 3600)))

_CANCEL_KB = InlineKeyboardMarkup([[
    InlineKeyboardButton("⏸ Pause", callback_data="dlp"),
    InlineKeyboardButton("✖️ Cancel", callback_data="dlx"),
]])
_PAUSED_KB = InlineKeyboardMarkup([[
    InlineKeyboardButton("▶️ Resume", callback_data="dlr"),
    InlineKeyboardButton("✖️ Cancel", callback_data="dlx"),
]])


class UrlDownloadError(Exception):
    """User-facing URL resolution / download failure."""


class DownloadCancelled(Exception):
    """The user confirmed Cancel — worker stops and cleans up staging."""


class DownloadPaused(Exception):
    """The user tapped Pause — worker releases the job (status='paused')."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _is_media(fname: str) -> bool:
    return os.path.splitext(fname)[1].lower() in _MEDIA_EXTS


def _speed_str(nbytes, secs):
    return (human_size(nbytes / secs).replace(" ", "") + "/s") if secs > 0 and nbytes >= 0 else ""


def _clean_filename(name: str) -> str:
    name = re.sub(r'[\\/*?:"<>|]', "_", name).strip()
    return name or "download_file"


def is_streamtape_url(url: str) -> bool:
    try:
        p = urlparse(url)
        return any(p.netloc.lower().endswith(d) for d in STREAMTAPE_DOMAINS)
    except Exception:
        return False


def is_gofile_url(url: str) -> bool:
    try:
        p = urlparse(url)
        return "gofile.io" in p.netloc.lower() and ("/d/" in p.path or "/d?" in url)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Streamtape Extractor
# ---------------------------------------------------------------------------
def _eval_js_piece(piece: str) -> str:
    m_str = re.search(r"['\"]([^'\"]*)['\"]", piece)
    if not m_str:
        return ""
    s = m_str.group(1)
    for m in re.finditer(r"\.(?:substring|slice)\((\d+)(?:,\s*(\d+))?\)", piece):
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) is not None else None
        s = s[start:end] if end is not None else s[start:]
    return s


def _eval_streamtape_js(expr: str) -> str:
    """Evaluate JS string concatenation and chained substring/slice calls from Streamtape script."""
    pieces = re.findall(
        r"(?:['\"][^'\"]*['\"]|\([^)]*['\"][^'\"]*['\"][^)]*\))(?:\.(?:substring|slice)\(\d+(?:,\s*\d+)?\))*",
        expr
    )
    if pieces:
        return "".join(_eval_js_piece(p) for p in pieces)
    return _eval_js_piece(expr)


async def extract_streamtape(url: str) -> List[Tuple[str, str, int, str]]:
    """Extract direct download link from Streamtape. Returns [(filename, stream_url, size, 'streamtape')]."""
    # Normalize URL: convert /e/ (embed) to /v/ (video)
    url = re.sub(r"/e/([a-zA-Z0-9_-]+)", r"/v/\1", url)
    headers = {
        "User-Agent": USER_AGENT,
        "Referer": "https://streamtape.com/",
    }

    async with httpx.AsyncClient(headers=headers, follow_redirects=True, timeout=15.0) as client:
        try:
            resp = await client.get(url)
        except Exception as e:
            raise UrlDownloadError(f"Gagal membuka link Streamtape: {e}")

        if resp.status_code != 200:
            raise UrlDownloadError(f"Streamtape HTTP error: {resp.status_code}")

        html_text = resp.text

        # 1. Extract video title
        m_title = re.search(r'<meta\s+name=["\']og:title["\']\s+content=["\']([^"\']+)["\']', html_text)
        if not m_title:
            m_title = re.search(r'<title>([^<]+)</title>', html_text)
        raw_title = m_title.group(1).strip() if m_title else ""
        if raw_title and " - Streamtape" in raw_title:
            raw_title = raw_title.replace(" - Streamtape", "").strip()

        # 2. Extract direct link
        # Look for norobotlink or robotlink script
        norobot_match = re.search(
            r"document\.getElementById\(['\"](?:no)?robotlink['\"]\)\.innerHTML\s*=\s*(.+?);",
            html_text
        )
        # Look for ideoooolink / videolink div
        ideooo_match = re.search(
            r'<div\s+id=["\'](?:ideoooolink|videolink|robotlink)["\'][^>]*>(.*?)</div>',
            html_text
        )

        stream_url = ""
        if norobot_match:
            eval_res = _eval_streamtape_js(norobot_match.group(1))
            if eval_res.startswith("//") or eval_res.startswith("http"):
                stream_url = eval_res
            elif ideooo_match:
                ideo_base = ideooo_match.group(1).strip()
                if "token=" in eval_res:
                    token = re.search(r"token=([^&'\"]+)", eval_res)
                    tok_val = token.group(1) if token else ""
                    stream_url = f"{ideo_base}{tok_val}"
                else:
                    stream_url = f"{ideo_base}{eval_res}"
            else:
                stream_url = eval_res

        if not stream_url and ideooo_match:
            ideo_base = ideooo_match.group(1).strip()
            tok_match = re.search(r"token=([^&'\"]+)", html_text)
            if tok_match:
                stream_url = f"{ideo_base}{tok_match.group(1)}"

        if not stream_url:
            raise UrlDownloadError("Tidak dapat mengekstrak link video Streamtape (video mungkin telah dihapus atau format halaman berubah).")

        if stream_url.startswith("//"):
            stream_url = "https:" + stream_url
        if "&stream=1" not in stream_url and "&dl=1" not in stream_url:
            stream_url += "&stream=1"

        # 3. Determine file size and final filename
        fname = _clean_filename(raw_title)
        if not fname.lower().endswith(".mp4"):
            fname += ".mp4"

        size = 0
        try:
            # Range request to inspect actual media stream headers and total content size
            range_resp = await client.get(stream_url, headers={"Range": "bytes=0-0"}, timeout=10.0)
            if range_resp.status_code in (200, 206):
                cr = range_resp.headers.get("content-range", "")
                if "/" in cr:
                    total_str = cr.split("/")[-1].strip()
                    if total_str.isdigit():
                        size = int(total_str)
                if not size:
                    cl = range_resp.headers.get("content-length")
                    if cl and cl.isdigit():
                        size = int(cl)
                cd = range_resp.headers.get("content-disposition", "")
                if "filename=" in cd:
                    fn_match = re.search(r'filename=["\']?([^"\';]+)', cd)
                    if fn_match:
                        fname = _clean_filename(fn_match.group(1))
        except Exception:
            pass

        return [(fname, stream_url, size, "streamtape")]


# ---------------------------------------------------------------------------
# Gofile Extractor
# ---------------------------------------------------------------------------
_gofile_token_cache: Optional[Tuple[str, float]] = None
_gofile_salt_cache: Optional[Tuple[str, float]] = None


async def _get_gofile_salt(client: httpx.AsyncClient) -> str:
    global _gofile_salt_cache
    now = time.monotonic()
    if _gofile_salt_cache and now - _gofile_salt_cache[1] < 3600:
        return _gofile_salt_cache[0]

    try:
        r_js = await client.get("https://gofile.io/js/wt.obf.js", timeout=10.0)
        m = re.search(r"\+['\"]((?:\\x[0-9a-fA-F]{2})+)['\"]", r_js.text)
        if m:
            hex_str = m.group(1).replace("\\x", "")
            salt = bytes.fromhex(hex_str).decode("latin1", "replace")
            _gofile_salt_cache = (salt, now)
            return salt
    except Exception as e:
        log.warning("Gofile salt fetch failed, using fallback: %s", e)

    return GOFILE_FALLBACK_SALT


async def _get_gofile_token(client: httpx.AsyncClient) -> str:
    global _gofile_token_cache
    now = time.monotonic()
    if _gofile_token_cache and now - _gofile_token_cache[1] < 1800:
        return _gofile_token_cache[0]

    try:
        r = await client.post("https://api.gofile.io/accounts", timeout=10.0)
        data = r.json()
        token = data.get("data", {}).get("token")
        if token:
            _gofile_token_cache = (token, now)
            return token
    except Exception as e:
        log.warning("Gofile guest account creation failed: %s", e)

    raise UrlDownloadError("Gagal membuat sesi tamu Gofile (API tidak merespons).")


async def extract_gofile(url: str) -> List[Tuple[str, str, int, str]]:
    """Extract direct download link(s) from Gofile. Returns list of [(filename, link, size, 'gofile')]."""
    m = re.search(r"/d/([a-zA-Z0-9_-]+)", url)
    if not m:
        m = re.search(r"[?&]c=([a-zA-Z0-9_-]+)", url)
    if not m:
        raise UrlDownloadError("Link Gofile tidak valid. Contoh: https://gofile.io/d/XXXXXX")

    content_id = m.group(1)
    headers = {"User-Agent": USER_AGENT}

    async with httpx.AsyncClient(headers=headers, follow_redirects=True, timeout=20.0) as client:
        token = await _get_gofile_token(client)
        salt = await _get_gofile_salt(client)

        t4 = str(int(time.time() / 14400))
        raw = f"{USER_AGENT}::{GOFILE_LANG}::{token}::{t4}::{salt}"
        wt = hashlib.sha256(raw.encode("utf-8")).hexdigest()

        try:
            r = await client.get(
                f"https://api.gofile.io/contents/{content_id}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-Website-Token": wt,
                    "X-BL": GOFILE_LANG,
                }
            )
        except Exception as e:
            raise UrlDownloadError(f"Gagal menghubungi Gofile API: {e}")

        if r.status_code != 200:
            raise UrlDownloadError(f"Gofile API HTTP {r.status_code}: {r.text[:100]}")

        res = r.json()
        status = res.get("status")
        if status != "ok":
            if status == "error-notFound":
                raise UrlDownloadError("File atau folder Gofile tidak ditemukan (mungkin telah dihapus).")
            if status == "error-password":
                raise UrlDownloadError("File Gofile dilindungi password.")
            raise UrlDownloadError(f"Gofile error: {status}")

        data = res.get("data", {})
        children = data.get("children", {})

        files = []
        if data.get("type") == "file":
            fname = _clean_filename(data.get("name") or f"{content_id}.file")
            size = int(data.get("size") or 0)
            link = data.get("link")
            if link:
                files.append((fname, link, size, "gofile"))
        elif children:
            for _, child in children.items():
                if child.get("type") == "file":
                    fname = _clean_filename(child.get("name") or "file")
                    size = int(child.get("size") or 0)
                    link = child.get("link")
                    if link:
                        files.append((fname, link, size, "gofile"))

        if not files:
            raise UrlDownloadError("Tidak ada file yang dapat didownload di dalam link Gofile ini.")

        return files


# ---------------------------------------------------------------------------
# Enqueue & Disk Reservation
# ---------------------------------------------------------------------------
async def _reclaim_orphan_staging(db) -> int:
    """Free disk space from finished/failed download dirs."""
    try:
        names = os.listdir(PIKPAK_STAGING_DIR)
    except OSError:
        return 0
    rs = await db.execute(
        "SELECT id FROM download_jobs "
        "WHERE status IN ('queued','downloading','downloaded','uploading','paused')"
    )
    active = {str(r[0]) for r in rs.rows}
    freed = 0
    for n in names:
        p = os.path.join(PIKPAK_STAGING_DIR, n)
        if n.isdigit() and n not in active and os.path.isdir(p):
            freed += sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(p) for f in fs)
            shutil.rmtree(p, ignore_errors=True)
    return freed


async def start_url_download(message, db, url_text: str, service: str = "url"):
    """Resolve URL, perform disk check, and enqueue into download_jobs."""
    url = url_text.strip()
    if not url:
        await message.reply_text("❌ Link kosong. Silakan kirim URL yang valid.")
        return

    status_msg = await message.reply_text(
        f"🔍 Mengecek link <b>{html.escape(service.title())}</b>…",
        parse_mode="HTML"
    )

    try:
        if service == "streamtape" or is_streamtape_url(url):
            resolved = await extract_streamtape(url)
            service = "streamtape"
        elif service == "gofile" or is_gofile_url(url):
            resolved = await extract_gofile(url)
            service = "gofile"
        else:
            raise UrlDownloadError("Layanan tidak didukung. Gunakan link Streamtape atau Gofile.")
    except UrlDownloadError as e:
        await status_msg.edit_text(f"❌ {e}")
        return
    except Exception as e:
        log.exception("Error extracting %s link: %s", service, url)
        await status_msg.edit_text(f"❌ Terjadi kesalahan saat memproses link: {e}")
        return

    # Total size disk check
    total_size = sum(sz for _, _, sz, _ in resolved)
    need = int(total_size * 1.2) if total_size > 0 else 500 * 1024 * 1024
    try:
        os.makedirs(PIKPAK_STAGING_DIR, exist_ok=True)
        free = shutil.disk_usage(PIKPAK_STAGING_DIR).free
    except OSError:
        free = None

    if free is not None and free < need:
        reclaimed = await _reclaim_orphan_staging(db)
        if reclaimed:
            free = shutil.disk_usage(PIKPAK_STAGING_DIR).free

    if free is not None and free < need:
        await status_msg.edit_text(
            f"❌ Ruang penyimpanan di server tidak cukup ({human_size(free)} tersisa, "
            f"dibutuhkan ~{human_size(need)})."
        )
        return

    # Enqueue each file
    chat_id = status_msg.chat_id
    for idx, (fname, link, size, src) in enumerate(resolved):
        split_note = " (akan di-upload dalam beberapa part)" if size > PIKPAK_MAX_BYTES else ""
        text = f"🗂 Queued {fname} ({human_size(size)}){split_note} for download…"

        if idx == 0:
            try:
                await status_msg.edit_text(text, reply_markup=_CANCEL_KB)
                msg_id = status_msg.message_id
            except Exception:
                sent = await message.reply_text(text, reply_markup=_CANCEL_KB)
                msg_id = sent.message_id
        else:
            sent = await message.reply_text(text, reply_markup=_CANCEL_KB)
            msg_id = sent.message_id

        await db.execute(
            "INSERT INTO download_jobs (source, remote_path, filename, size, status, chat_id, message_id) "
            "VALUES (?, ?, ?, ?, 'queued', ?, ?) RETURNING id",
            [src, link, fname, size, chat_id, msg_id],
        )
        log.info("%s download job queued: %s (%s)", src.title(), fname, human_size(size))


# ---------------------------------------------------------------------------
# HTTP Streaming Downloader (Worker Core)
# ---------------------------------------------------------------------------
async def http_stream_copy(bot, db, job, dst: str, state: dict):
    """Download an HTTP link directly to dst with resume, progress throttling, stall timer, and cancel/pause checks."""
    url = job["remote_path"]
    size = int(job.get("size") or 0)
    fname = job["filename"] or f"download_{job['id']}"
    os.makedirs(dst, exist_ok=True)
    fpath = os.path.join(dst, fname)

    done = min(int(job.get("bytes_done") or 0), size) if size else int(job.get("bytes_done") or 0)
    now = time.monotonic()
    state["spd_bytes"], state["spd_t"] = done, now
    state["done0"], state["t0"] = done, now
    win_bytes, win_t = done, now

    headers = {"User-Agent": USER_AGENT}
    if job.get("source") == "streamtape":
        headers["Referer"] = "https://streamtape.com/"
    elif job.get("source") == "gofile":
        try:
            async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=10.0) as c:
                g_token = await _get_gofile_token(c)
            headers["Authorization"] = f"Bearer {g_token}"
            headers["Cookie"] = f"accountToken={g_token}"
        except Exception as e:
            log.warning("Could not fetch Gofile token for stream download: %s", e)

    mode = "r+b" if (os.path.exists(fpath) and done > 0) else "wb"
    if mode == "wb":
        done = 0

    req_headers = dict(headers)
    if done > 0:
        req_headers["Range"] = f"bytes={done}-"

    async with httpx.AsyncClient(headers=req_headers, follow_redirects=True, timeout=httpx.Timeout(60.0, connect=30.0)) as client:
        async with client.stream("GET", url) as response:
            if response.status_code == 416:
                # Range not satisfiable (already completed)
                pass
            elif response.status_code not in (200, 206):
                raise UrlDownloadError(f"HTTP stream error {response.status_code}: {response.reason_phrase}")

            if response.status_code == 200 and done > 0:
                # Server ignored Range header and sent full body from 0
                done = 0
                mode = "wb"

            if not size:
                cl = response.headers.get("content-length")
                if cl and cl.isdigit():
                    size = done + int(cl)
                    await db.execute("UPDATE download_jobs SET size=? WHERE id=?", [size, job["id"]])
                    job["size"] = size

            with open(fpath, mode) as f:
                if done > 0 and mode == "r+b":
                    f.seek(done)

                async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    f.write(chunk)
                    done += len(chunk)
                    now = time.monotonic()

                    if done - win_bytes >= STALL_MIN_BYTES:
                        win_bytes, win_t = done, now

                    if now - win_t > STALL_WINDOW_S:
                        await db.execute("UPDATE download_jobs SET bytes_done=? WHERE id=?", [done, job["id"]])
                        raise UrlDownloadError(
                            f"⏱ Aborted {fname} — no progress for {STALL_WINDOW_S // 60} min (stalled at {human_size(done)})."
                        )

                    if now - state["start"] > MAX_DL_SECONDS:
                        await db.execute("UPDATE download_jobs SET bytes_done=? WHERE id=?", [done, job["id"]])
                        raise UrlDownloadError(
                            f"⏱ Aborted {fname} — hit time ceiling at {human_size(done)}/{human_size(size)}."
                        )

                    if now - state["last_db"] >= DB_THROTTLE_S:
                        pct = min(99, int(done / size * 100)) if size else 0
                        spd = _speed_str(done - state["spd_bytes"], now - state["spd_t"])
                        avg = ((done - state["done0"]) / (now - state["t0"])) if now - state["t0"] > 15 else 0
                        eta = f" · ETA {_fmt_eta((size - done) / avg)}" if avg > 0 and size > done else ""
                        state["spd_bytes"], state["spd_t"], state["last_db"] = done, now, now

                        rs = await db.execute("SELECT status FROM download_jobs WHERE id=?", [job["id"]])
                        st = rs.rows[0][0] if rs.rows else None
                        if st in ("failed", "paused"):
                            await db.execute("UPDATE download_jobs SET bytes_done=? WHERE id=?", [done, job["id"]])
                            raise DownloadCancelled() if st == "failed" else DownloadPaused()

                        await db.execute(
                            "UPDATE download_jobs SET progress=?, speed=?, bytes_done=?, updated_at=now_text() WHERE id=?",
                            [pct, spd + eta, done, job["id"]]
                        )

                        now_t = time.monotonic()
                        if now_t - state["last_edit"] >= EDIT_THROTTLE_S and job.get("chat_id") and job.get("message_id"):
                            state["last_edit"] = now_t
                            try:
                                sz_txt = f"{human_size(done)} / {human_size(size)}" if size else f"{human_size(done)}"
                                await bot.edit_message_text(
                                    chat_id=job["chat_id"],
                                    message_id=job["message_id"],
                                    text=f"⬇️ {fname}\n{sz_txt} ({pct}%, {spd}{eta})",
                                    reply_markup=_CANCEL_KB,
                                )
                            except Exception:
                                pass

    await db.execute(
        "UPDATE download_jobs SET progress=100, bytes_done=?, updated_at=now_text() WHERE id=?",
        [done, job["id"]]
    )


# ---------------------------------------------------------------------------
# Telegram Command Handlers
# ---------------------------------------------------------------------------
async def on_streamtape(update, context):
    user, message = update.effective_user, update.message
    if not message or not user:
        return
    db = context.bot_data["db"]
    if not await is_user_authorized(db, user.id):
        await message.reply_text(
            f"⛔ Not authorized. Use `/auth <password>` or ask the owner.\nYour Telegram ID: `{user.id}`",
            parse_mode="Markdown",
        )
        return
    url = " ".join(context.args or []).strip()
    if not url:
        context.user_data["url_await"] = "streamtape"
        prompt = await message.reply_text(
            "🎬 Kirim link <b>Streamtape</b> yang ingin di-download.\n"
            "Contoh: <code>https://streamtape.com/v/XXXXX/...</code>\n\n"
            "Kirim /cancel untuk membatalkan.",
            parse_mode="HTML",
            reply_markup=ForceReply(input_field_placeholder="https://streamtape.com/v/..."),
        )
        context.user_data["url_prompt_id"] = prompt.message_id
        return
    await start_url_download(message, db, url, "streamtape")


async def on_gofile(update, context):
    user, message = update.effective_user, update.message
    if not message or not user:
        return
    db = context.bot_data["db"]
    if not await is_user_authorized(db, user.id):
        await message.reply_text(
            f"⛔ Not authorized. Use `/auth <password>` or ask the owner.\nYour Telegram ID: `{user.id}`",
            parse_mode="Markdown",
        )
        return
    url = " ".join(context.args or []).strip()
    if not url:
        context.user_data["url_await"] = "gofile"
        prompt = await message.reply_text(
            "📁 Kirim link <b>Gofile</b> yang ingin di-download.\n"
            "Contoh: <code>https://gofile.io/d/XXXXX</code>\n\n"
            "Kirim /cancel untuk membatalkan.",
            parse_mode="HTML",
            reply_markup=ForceReply(input_field_placeholder="https://gofile.io/d/..."),
        )
        context.user_data["url_prompt_id"] = prompt.message_id
        return
    await start_url_download(message, db, url, "gofile")

