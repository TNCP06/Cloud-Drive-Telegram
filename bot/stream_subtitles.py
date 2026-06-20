"""Background subtitle generation for the streamer.

Generation is ABSENCE-driven, not view-driven: the streamer's backfill loop finds any
indexed video that has no subtitles yet, downloads it (Local Bot API mode), and runs a
job that extracts the audio, transcribes it via Groq's free Whisper API (with automatic
key + model failover on rate-limit), and translates the result into English + Indonesian.
The three WebVTT tracks (original, en, id) are written to the PERSISTENT /subtitles volume
and recorded in the `subtitles` Turso table so the web player can offer them as <track>s.
(Playing a video does NOT trigger subtitle generation — it stays off the streaming path.)

Design mirrors stream_compress.py: single-job concurrency, a `.done` marker so finished
parts aren't retried, and a never-evict persistent store (subtitles are cheap to keep,
expensive to regenerate, and must survive while the video stays indexed).

Long videos split their audio into several time-sliced chunks, each transcribed
independently and PER-CHUNK REPAIRABLE: a chunk that fails (e.g. a transient Groq 5xx) does
not abort the whole video — the chunks that succeeded are cached (`part_{id}.chunks.json`),
PARTIAL subtitles are written from them, and a `.partial` marker is left so a later backfill
pass re-transcribes ONLY the missing chunks (resuming from the cache). Once every chunk is in
the part is finalised with `.done` and the scaffolding is dropped; a chunk that keeps failing
is given up on after SUBTITLE_MAX_REPAIR_ATTEMPTS, keeping whatever partial tracks exist.
"""

import asyncio
import json
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
# Per-chunk repair: a video whose audio splits into several chunks transcribes each chunk
# independently. If some chunks fail (e.g. a transient Groq 5xx), the successful chunks are
# cached and a `.partial` marker is left so a later pass re-transcribes ONLY the missing
# chunks. After this many total attempts a still-incomplete video is finalised with whatever
# partial subtitles it has (so one permanently-bad chunk can't block it forever).
SUBTITLE_MAX_REPAIR_ATTEMPTS = int(os.environ.get("SUBTITLE_MAX_REPAIR_ATTEMPTS", "4"))

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


# --- Per-chunk repair state (chunk cache + .partial marker) -----------------
def _chunks_cache_path(part_id: int) -> Path:
    """JSON cache of successfully transcribed chunks (survives between repair attempts)."""
    return SUBTITLES_DIR / f"part_{part_id}.chunks.json"


def _partial_marker(part_id: int) -> Path:
    """Present while a video is incomplete (some chunks still missing). Holds an attempt count."""
    return SUBTITLES_DIR / f"part_{part_id}.partial"


def _load_chunks_cache(part_id: int) -> dict:
    p = _chunks_cache_path(part_id)
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("chunks"), dict):
                return data
        except Exception:  # noqa: BLE001
            pass
    return {"lang": "xx", "chunks": {}}


def _save_chunks_cache(part_id: int, data: dict) -> None:
    try:
        _chunks_cache_path(part_id).write_text(json.dumps(data), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def _cleanup_chunk_state(part_id: int) -> None:
    """Drop the per-chunk cache + partial marker (called once a part is finalised)."""
    _safe_unlink(_chunks_cache_path(part_id))
    _safe_unlink(_partial_marker(part_id))


def partial_attempts(part_id: int) -> int:
    p = _partial_marker(part_id)
    if not p.exists():
        return 0
    try:
        return int((p.read_text(encoding="utf-8").strip() or "0"))
    except Exception:  # noqa: BLE001
        return 0


def is_subtitle_partial(part_id: int) -> bool:
    """True if this part has subtitles but is still incomplete (repairable)."""
    return _partial_marker(part_id).exists()


def partial_part_ids() -> list[int]:
    """Part ids with a `.partial` marker (incomplete, repairable), oldest id first."""
    if not SUBTITLES_DIR.exists():
        return []
    out = []
    for f in SUBTITLES_DIR.glob("part_*.partial"):
        m = re.match(r"part_(\d+)\.partial$", f.name)
        if m:
            out.append(int(m.group(1)))
    return sorted(out)


def _bump_partial(part_id: int) -> bool:
    """Record one more repair attempt. If the budget is exhausted, finalise the part as
    `.done` (keeping whatever partial tracks exist) and return True; otherwise refresh the
    `.partial` marker and return False (eligible for another repair pass)."""
    attempts = partial_attempts(part_id) + 1
    if attempts >= SUBTITLE_MAX_REPAIR_ATTEMPTS:
        try:
            _done_marker(part_id).write_text("partial-giveup", encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass
        _cleanup_chunk_state(part_id)
        return True
    try:
        _partial_marker(part_id).write_text(str(attempts), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    return False


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


async def _transcribe_audio(part_id: int, src_path: str) -> tuple[list[dict], str, int, int]:
    """Extract audio, transcribe each chunk (skipping ones already cached), merge segments.

    Per-chunk resilient: a chunk that keeps failing (e.g. transient Groq 5xx) does NOT abort
    the whole video — its slot is simply left missing and the chunks that DID succeed are
    cached (`part_{id}.chunks.json`) so a later repair pass only re-transcribes the gaps.

    Returns (segments, source_iso_lang, missing_chunks, total_chunks). segments carry absolute
    timestamps (chunk index * CHUNK_SECONDS offset applied).
    """
    tmp = Path(tempfile.mkdtemp(prefix="subgen_"))
    try:
        chunks = await _extract_audio_chunks(src_path, tmp)
        total = len(chunks)
        if total == 0:
            # ffmpeg succeeded (rc 0) but produced no audio → the video has no audio track.
            # A real ffmpeg failure (rc != 0) raises inside _extract_audio_chunks instead.
            log.info("Subtitle: %s has no audio track — nothing to transcribe", src_path)
            return [], "xx", 0, 0

        cache = _load_chunks_cache(part_id)
        cached: dict = cache.get("chunks", {})           # {"<idx>": [ {start,end,text}, … ]}
        source_lang = cache.get("lang", "xx")

        timeout = httpx.Timeout(180.0, connect=30.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            for idx, chunk in enumerate(chunks):
                key = str(idx)
                if key in cached:
                    continue  # already transcribed in an earlier attempt — keep it
                try:
                    result = await _transcribe_chunk(client, chunk)
                except Exception as e:  # noqa: BLE001
                    log.warning("Subtitle: part %d chunk %d failed (%s) — leaving for repair",
                                part_id, idx, e)
                    continue  # missing slot; a later pass retries just this chunk
                if source_lang == "xx":
                    source_lang = _iso_from_groq_language(result.get("language"))
                segs = []
                for seg in result.get("segments", []) or []:
                    text = (seg.get("text") or "").strip()
                    if not text:
                        continue
                    segs.append({
                        "start": float(seg.get("start", 0.0)),
                        "end": float(seg.get("end", 0.0)),
                        "text": text,
                    })
                cached[key] = segs
                # Persist after every chunk so progress survives a crash/restart mid-video.
                _save_chunks_cache(part_id, {"lang": source_lang, "chunks": cached})

        # Merge every cached chunk in order, applying each chunk's time offset.
        all_segments: list[dict] = []
        for idx in range(total):
            offset = idx * SUBTITLE_CHUNK_SECONDS
            for seg in cached.get(str(idx), []):
                all_segments.append({
                    "start": seg["start"] + offset,
                    "end": seg["end"] + offset,
                    "text": seg["text"],
                })
        missing = total - sum(1 for idx in range(total) if str(idx) in cached)
        return all_segments, source_lang, missing, total
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
            segments, source_lang, missing, total = await _transcribe_audio(part_id, src_path)

            if total == 0:
                # No audio track at all → nothing will ever be produced. Permanent skip.
                log.info("Subtitle: part %d has no audio — marking done", part_id)
                _done_marker(part_id).write_text("no-audio")
                _cleanup_chunk_state(part_id)
                return
            if not segments:
                if missing == 0:
                    # Fully transcribed but genuinely no speech → permanent skip.
                    log.info("Subtitle: no speech segments for part %d — marking done", part_id)
                    _done_marker(part_id).write_text("no-speech")
                    _cleanup_chunk_state(part_id)
                else:
                    # Nothing usable yet AND some chunks still missing → leave for repair.
                    finalized = _bump_partial(part_id)
                    log.info("Subtitle: part %d — %d/%d chunks missing, no segments yet%s",
                             part_id, missing, total,
                             " (giving up)" if finalized else " — will repair later")
                return

            # Write/refresh the ORIGINAL track from all chunks transcribed so far.
            orig_lang = source_lang if source_lang != "xx" else "orig"
            subtitle_path(part_id, orig_lang).write_text(_build_vtt(segments), encoding="utf-8")
            await _record_subtitle(db, part_id, orig_lang)

            # (Re)translate to each target language from the current full set. A repair pass
            # fills a once-missing chunk, so we always rebuild the translation rather than
            # skip when the target file already exists.
            for target in SUBTITLE_TARGET_LANGS:
                if target == source_lang:
                    continue
                # Best-effort: a translation failure must never abort finalisation (else a
                # fully-transcribed video would be re-downloaded every restart just to retry
                # the translation). Worst case the part keeps only its original-language track.
                try:
                    translated = await asyncio.to_thread(
                        _translate_segments, segments, target, source_lang
                    )
                except Exception as e:  # noqa: BLE001
                    log.warning("Subtitle: translate part %d → %s failed (%s) — leaving untranslated",
                                part_id, target, e)
                    translated = None
                if translated:
                    subtitle_path(part_id, target).write_text(_build_vtt(translated), encoding="utf-8")
                    await _record_subtitle(db, part_id, target)

            if missing == 0:
                # Every chunk transcribed → finished. Drop the repair scaffolding.
                _done_marker(part_id).write_text("ok")
                _cleanup_chunk_state(part_id)
                log.info("Subtitle: part %d complete (%s)", part_id, ", ".join(available_langs(part_id)))
            else:
                # Some chunks still missing: the part now has PARTIAL subtitles. Keep the
                # cache + .partial marker so a later pass repairs only the gaps.
                finalized = _bump_partial(part_id)
                log.info("Subtitle: part %d PARTIAL (%d/%d chunks missing) — wrote %s%s",
                         part_id, missing, total, ", ".join(available_langs(part_id)),
                         " (giving up, budget exhausted)" if finalized else " — will repair later")
    except Exception:  # noqa: BLE001
        log.exception("Subtitle worker failed for part %d", part_id)
    finally:
        _subtitling.discard(part_id)


def is_subtitled_done(part_id: int) -> bool:
    """True if this part was already processed (subtitled, or recorded as no-speech)."""
    return _done_marker(part_id).exists()


async def run_subtitle_job(db, part_id: int, src_path: str, fallback_path: str | None = None) -> None:
    """Await one subtitle job to completion (used by the retroactive backfill loop)."""
    await _subtitle_worker(db, part_id, src_path, fallback_path)
