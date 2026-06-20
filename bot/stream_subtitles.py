"""Background subtitle generation for the streamer.

After a video lands on disk (Local Bot API mode), an async job extracts the audio,
transcribes it via Groq's free Whisper API (with automatic key + model failover on
rate-limit), and translates the result into English + Indonesian. The three WebVTT
tracks (original, en, id) are written to the PERSISTENT /subtitles volume and recorded
in the `subtitles` Turso table so the web player can offer them as <track>s.

Design mirrors stream_compress.py: fire-and-forget, single-job concurrency, a `.done`
marker so finished/failed parts aren't retried, and a never-evict persistent store
(subtitles are cheap to keep, expensive to regenerate, and must survive while the
video stays indexed).
"""

import asyncio
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path

import httpx

log = logging.getLogger("streamer")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SUBTITLE_GEN = os.environ.get("SUBTITLE_GEN", "1") not in ("0", "false", "False", "")
SUBTITLES_DIR = Path(os.environ.get("SUBTITLES_DIR", "/subtitles"))

# Comma-separated Groq API keys — rotated on rate-limit (429) for free-tier failover.
GROQ_API_KEYS = [k.strip() for k in os.environ.get("GROQ_API_KEYS", "").split(",") if k.strip()]
# Models tried in order (turbo first = faster/cheaper, falls back to full v3).
GROQ_STT_MODELS = [m.strip() for m in os.environ.get(
    "GROQ_STT_MODELS", "whisper-large-v3-turbo,whisper-large-v3").split(",") if m.strip()]
GROQ_TRANSCRIBE_URL = os.environ.get(
    "GROQ_TRANSCRIBE_URL", "https://api.groq.com/openai/v1/audio/transcriptions")

# Target languages every video should end up with (besides the original).
SUBTITLE_TARGET_LANGS = [l.strip() for l in os.environ.get(
    "SUBTITLE_TARGET_LANGS", "en,id").split(",") if l.strip()]
# Split audio into chunks of this many seconds to stay under Groq's per-file size cap
# and to spread requests across keys. Each chunk is offset by index * CHUNK_SECONDS.
SUBTITLE_CHUNK_SECONDS = int(os.environ.get("SUBTITLE_CHUNK_SECONDS", "600"))
# Skip videos shorter/smaller than this (audio extraction still cheap, but avoids noise).
SUBTITLE_MIN_BYTES = int(os.environ.get("SUBTITLE_MIN_MB", "1")) * 1048576

# --- Retroactive backfill: subtitle already-indexed videos one at a time ---
SUBTITLE_BACKFILL = os.environ.get("SUBTITLE_BACKFILL", "1") not in ("0", "false", "False", "")
# Optional extra pace between videos. 0 = back-to-back (the 3 rotating GROQ_API_KEYS already
# absorb Groq rate limits, and each video's own processing time provides natural spacing).
SUBTITLE_BACKFILL_INTERVAL_S = int(os.environ.get("SUBTITLE_BACKFILL_INTERVAL_S", "0"))
# When nothing is left to do, re-scan this often.
SUBTITLE_BACKFILL_IDLE_S = int(os.environ.get("SUBTITLE_BACKFILL_IDLE_S", "3600"))
# Wait this long after startup before the first backfill (let the service settle).
SUBTITLE_BACKFILL_START_DELAY_S = int(os.environ.get("SUBTITLE_BACKFILL_START_DELAY_S", "120"))

# Background bookkeeping
_subtitling: set[int] = set()
_subtitle_sem: "asyncio.Semaphore | None" = None  # created in lifespan


def init_subtitle_semaphore() -> None:
    """Create the concurrency semaphore inside the running event loop (call from lifespan)."""
    global _subtitle_sem
    _subtitle_sem = asyncio.Semaphore(1)


# ---------------------------------------------------------------------------
# Paths / helpers
# ---------------------------------------------------------------------------
def subtitle_path(part_id: int, lang: str) -> Path:
    return SUBTITLES_DIR / f"part_{part_id}.{lang}.vtt"


def _done_marker(part_id: int) -> Path:
    return SUBTITLES_DIR / f"part_{part_id}.done"


def available_langs(part_id: int) -> list[str]:
    """Languages with a VTT on disk for this part (used by the streamer list endpoint)."""
    if not SUBTITLES_DIR.exists():
        return []
    out = []
    for f in SUBTITLES_DIR.glob(f"part_{part_id}.*.vtt"):
        m = re.match(rf"part_{part_id}\.(.+)\.vtt$", f.name)
        if m:
            out.append(m.group(1))
    return sorted(out)


def _safe_unlink(p: Path) -> None:
    try:
        if p.exists():
            p.unlink()
    except Exception:  # noqa: BLE001
        pass


# Groq returns the language as an English word ("english", "indonesian", …).
_LANG_NAME_TO_ISO = {
    "english": "en", "indonesian": "id", "malay": "ms", "japanese": "ja",
    "korean": "ko", "chinese": "zh", "mandarin": "zh", "spanish": "es",
    "french": "fr", "german": "de", "portuguese": "pt", "russian": "ru",
    "arabic": "ar", "hindi": "hi", "thai": "th", "vietnamese": "vi",
    "italian": "it", "dutch": "nl", "turkish": "tr", "tagalog": "tl",
    "filipino": "tl",
}


def _iso_from_groq_language(language: str | None) -> str:
    if not language:
        return "xx"
    language = language.strip().lower()
    if language in _LANG_NAME_TO_ISO:
        return _LANG_NAME_TO_ISO[language]
    # already an ISO code?
    if len(language) == 2:
        return language
    return language[:2]


def _fmt_ts(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def _build_vtt(segments: list[dict]) -> str:
    """segments: [{start, end, text}] → WebVTT string."""
    lines = ["WEBVTT", ""]
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        lines.append(f"{_fmt_ts(seg['start'])} --> {_fmt_ts(seg['end'])}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Audio extraction (ffmpeg) — one pass into time-sliced FLAC chunks
# ---------------------------------------------------------------------------
async def _extract_audio_chunks(src_path: str, out_dir: Path) -> list[Path]:
    """Extract 16 kHz mono FLAC, segmented by SUBTITLE_CHUNK_SECONDS. Returns sorted chunk paths."""
    pattern = str(out_dir / "chunk_%04d.flac")
    cmd = [
        "ffmpeg", "-y", "-i", src_path,
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac",
        "-f", "segment", "-segment_time", str(SUBTITLE_CHUNK_SECONDS),
        pattern,
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        tail = stderr[-500:].decode("utf-8", "ignore") if stderr else ""
        raise RuntimeError(f"ffmpeg audio extract failed (rc={proc.returncode}): {tail}")
    return sorted(out_dir.glob("chunk_*.flac"))


# ---------------------------------------------------------------------------
# Groq transcription with key + model failover
# ---------------------------------------------------------------------------
_key_index = 0


def _key_order() -> list[str]:
    """Return the keys starting at a rotating offset so load is spread across calls."""
    global _key_index
    if not GROQ_API_KEYS:
        return []
    start = _key_index % len(GROQ_API_KEYS)
    _key_index += 1
    return GROQ_API_KEYS[start:] + GROQ_API_KEYS[:start]


async def _transcribe_chunk(client: httpx.AsyncClient, audio_path: Path) -> dict:
    """POST one audio chunk to Groq, rotating keys on 429 and models on exhaustion."""
    last_err: Exception | None = None
    for model in GROQ_STT_MODELS:
        for key in _key_order():
            try:
                with open(audio_path, "rb") as fh:
                    files = {"file": (audio_path.name, fh, "audio/flac")}
                    data = {"model": model, "response_format": "verbose_json", "temperature": "0"}
                    resp = await client.post(
                        GROQ_TRANSCRIBE_URL,
                        headers={"Authorization": f"Bearer {key}"},
                        files=files, data=data,
                    )
                if resp.status_code == 429:
                    log.warning("Groq 429 (rate limit) on key …%s model %s — rotating", key[-4:], model)
                    last_err = RuntimeError(f"429 on {model}")
                    await asyncio.sleep(1)
                    continue
                if resp.status_code in (500, 502, 503, 529):
                    last_err = RuntimeError(f"{resp.status_code} on {model}")
                    await asyncio.sleep(1)
                    continue
                resp.raise_for_status()
                return resp.json()
            except httpx.HTTPError as e:
                last_err = e
                log.warning("Groq request error on key …%s model %s: %s", key[-4:], model, e)
                await asyncio.sleep(1)
                continue
    raise last_err or RuntimeError("All Groq keys/models failed")


async def _transcribe_audio(src_path: str) -> tuple[list[dict], str]:
    """Extract audio, transcribe every chunk, merge segments with time offsets.

    Returns (segments, source_iso_lang). segments: [{start, end, text}].
    """
    tmp = Path(tempfile.mkdtemp(prefix="subgen_"))
    try:
        chunks = await _extract_audio_chunks(src_path, tmp)
        if not chunks:
            raise RuntimeError("No audio chunks produced (video may have no audio track)")

        all_segments: list[dict] = []
        source_lang = "xx"
        timeout = httpx.Timeout(180.0, connect=30.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            for idx, chunk in enumerate(chunks):
                offset = idx * SUBTITLE_CHUNK_SECONDS
                result = await _transcribe_chunk(client, chunk)
                if idx == 0:
                    source_lang = _iso_from_groq_language(result.get("language"))
                for seg in result.get("segments", []) or []:
                    text = (seg.get("text") or "").strip()
                    if not text:
                        continue
                    all_segments.append({
                        "start": float(seg.get("start", 0.0)) + offset,
                        "end": float(seg.get("end", 0.0)) + offset,
                        "text": text,
                    })
        return all_segments, source_lang
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# Translation (deep-translator → Google free endpoint), timestamps preserved
# ---------------------------------------------------------------------------
def _translate_segments(segments: list[dict], target: str, source: str) -> list[dict] | None:
    """Translate segment texts to `target`, keeping timestamps. Runs in a thread (blocking lib).

    Batches segments by character budget and falls back to per-item on a count mismatch
    so we never misalign text with timestamps. Returns None if the library is missing.
    """
    try:
        from deep_translator import GoogleTranslator
    except Exception as e:  # noqa: BLE001
        log.warning("deep-translator not available (%s) — skipping %s track", e, target)
        return None

    translator = GoogleTranslator(source=source if source not in ("xx", "") else "auto", target=target)
    SEP = "\n"
    CHAR_BUDGET = 3500

    def translate_batch(texts: list[str]) -> list[str]:
        if not texts:
            return []
        joined = SEP.join(texts)
        try:
            res = translator.translate(joined)
            if res:
                parts = res.split(SEP)
                if len(parts) == len(texts):
                    return parts
        except Exception as e:  # noqa: BLE001
            log.warning("Batch translate to %s failed (%s) — per-item fallback", target, e)
        out = []
        for t in texts:
            try:
                out.append(translator.translate(t) or t)
            except Exception:  # noqa: BLE001
                out.append(t)
        return out

    translated: list[dict] = []
    batch: list[dict] = []
    batch_len = 0
    for seg in segments:
        t = seg["text"]
        if batch and batch_len + len(t) > CHAR_BUDGET:
            texts = translate_batch([b["text"] for b in batch])
            for b, nt in zip(batch, texts):
                translated.append({"start": b["start"], "end": b["end"], "text": nt})
            batch, batch_len = [], 0
        batch.append(seg)
        batch_len += len(t) + 1
    if batch:
        texts = translate_batch([b["text"] for b in batch])
        for b, nt in zip(batch, texts):
            translated.append({"start": b["start"], "end": b["end"], "text": nt})
    return translated


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------
async def _record_subtitle(db, part_id: int, lang: str) -> None:
    if db is None:
        return
    try:
        await db.execute(
            "INSERT INTO subtitles (part_id, lang, created_at) VALUES (?, ?, datetime('now')) "
            "ON CONFLICT(part_id, lang) DO UPDATE SET created_at=datetime('now')",
            [part_id, lang],
        )
    except Exception as e:  # noqa: BLE001
        log.warning("Could not record subtitle row part %d/%s: %s", part_id, lang, e)


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------
async def _subtitle_worker(db, part_id: int, src_path: str, fallback_path: str | None = None) -> None:
    if _done_marker(part_id).exists() or part_id in _subtitling:
        return
    _subtitling.add(part_id)
    try:
        async with _subtitle_sem:  # never run two STT jobs at once (and not beside a transcode)
            if _done_marker(part_id).exists():
                return
            # Prefer the original, but the compress job may reclaim it first — fall back
            # to the compressed copy (same audio) if the original is already gone.
            video = src_path if (src_path and os.path.exists(src_path)) else None
            if not video and fallback_path and os.path.exists(fallback_path):
                video = fallback_path
            if not video:
                log.info("Subtitle: no video on disk for part %d — skipping", part_id)
                return
            src_path = video
            if os.path.getsize(src_path) < SUBTITLE_MIN_BYTES:
                return
            if not GROQ_API_KEYS:
                log.warning("Subtitle: no GROQ_API_KEYS configured — skipping part %d", part_id)
                return

            SUBTITLES_DIR.mkdir(parents=True, exist_ok=True)
            log.info("Subtitle: transcribing part %d …", part_id)
            segments, source_lang = await _transcribe_audio(src_path)
            if not segments:
                log.info("Subtitle: no speech segments for part %d — marking done", part_id)
                _done_marker(part_id).write_text("no-speech")
                return

            # Write the ORIGINAL track.
            orig_lang = source_lang if source_lang != "xx" else "orig"
            subtitle_path(part_id, orig_lang).write_text(_build_vtt(segments), encoding="utf-8")
            await _record_subtitle(db, part_id, orig_lang)
            log.info("Subtitle: part %d original track (%s) written", part_id, orig_lang)

            # Translate to each target language (skip if it equals the source).
            for target in SUBTITLE_TARGET_LANGS:
                if target == source_lang:
                    continue
                if subtitle_path(part_id, target).exists():
                    continue
                translated = await asyncio.to_thread(
                    _translate_segments, segments, target, source_lang
                )
                if translated:
                    subtitle_path(part_id, target).write_text(_build_vtt(translated), encoding="utf-8")
                    await _record_subtitle(db, part_id, target)
                    log.info("Subtitle: part %d %s track written", part_id, target)

            _done_marker(part_id).write_text("ok")
            log.info("Subtitle: part %d complete (%s)", part_id, ", ".join(available_langs(part_id)))
    except Exception:  # noqa: BLE001
        log.exception("Subtitle worker failed for part %d", part_id)
    finally:
        _subtitling.discard(part_id)


def schedule_subtitles(db, part_id: int, src_path: str, fallback_path: str | None = None) -> None:
    """Fire-and-forget subtitle generation if not already done/queued."""
    if not SUBTITLE_GEN or _subtitle_sem is None:
        return
    if part_id in _subtitling or _done_marker(part_id).exists():
        return
    if not GROQ_API_KEYS:
        return
    asyncio.create_task(_subtitle_worker(db, part_id, src_path, fallback_path))


def is_subtitled_done(part_id: int) -> bool:
    """True if this part was already processed (subtitled, or recorded as no-speech)."""
    return _done_marker(part_id).exists()


async def run_subtitle_job(db, part_id: int, src_path: str, fallback_path: str | None = None) -> None:
    """Await one subtitle job to completion (used by the retroactive backfill loop)."""
    await _subtitle_worker(db, part_id, src_path, fallback_path)
