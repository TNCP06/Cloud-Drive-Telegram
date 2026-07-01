"""Background subtitle generation for the streamer.

Generation is ABSENCE-driven, not view-driven: the streamer's backfill loop finds any
indexed video that has no subtitles yet, downloads it (Local Bot API mode), and runs a
job that extracts the audio, transcribes it (Groq's free Whisper API with automatic key + model
failover, then a Gladia and/or Cloudflare Workers AI failover; Gladia can be promoted to primary
with GLADIA_PRIMARY=1), and translates the result into English + Indonesian.
The three WebVTT tracks (original, en, id) are written to the PERSISTENT /subtitles volume
and recorded in the `subtitles` Turso table so the web player can offer them as <track>s.
Playing a video does not run STT on the streaming path, but it DOES bump that video to the front
of the backfill queue (streamer's `_enqueue_priority_subtitle` + wake) so a just-opened/just-
uploaded video is subtitled next — still by this single serialized worker, never a parallel job —
and the web player loads the tracks live as they land.

Design mirrors stream_compress.py: single-job concurrency, a `.done` marker so finished
parts aren't retried, and a never-evict persistent store (subtitles are cheap to keep,
expensive to regenerate, and must survive while the video stays indexed).

Long videos split their audio into several time-sliced chunks transcribed CONCURRENTLY
(each on a different rotating API key, bounded by SUBTITLE_CHUNK_CONCURRENCY) with an in-job
retry/back-off so transient Groq blips are absorbed while the video is still on disk. Each chunk
is also PER-CHUNK REPAIRABLE: a chunk that keeps failing (e.g. a persistent Groq 5xx) does
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

# Translation failover via a Groq LLM (reuses the free Groq keys). The free Google endpoint
# (deep-translator) frequently throttles or silently echoes the input under bursts; when Google
# can't translate a line, we fall back to an instruction-tuned Groq chat model — far more reliable
# (we control the quota, not Google's per-IP throttle) and cleaner on hard pairs (e.g. Traditional
# Chinese → id). Set GROQ_TRANSLATE=0 to disable and keep the Google-only behaviour.
GROQ_TRANSLATE = os.environ.get("GROQ_TRANSLATE", "1") not in ("0", "false", "False", "")
GROQ_TRANSLATE_MODEL = os.environ.get("GROQ_TRANSLATE_MODEL", "llama-3.3-70b-versatile")
GROQ_CHAT_URL = os.environ.get("GROQ_CHAT_URL", "https://api.groq.com/openai/v1/chat/completions")

# Optional SERVER-SIDE STT FAILOVER via Cloudflare Workers AI Whisper — used ONLY when every Groq
# key/model attempt fails (e.g. a Groq outage). Dormant unless both vars are set, so leaving them
# empty keeps the Groq-only behaviour. Free tier: 10k Neurons/day (plenty for a failover).
CLOUDFLARE_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
CLOUDFLARE_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
CLOUDFLARE_STT_MODEL = os.environ.get("CLOUDFLARE_STT_MODEL", "@cf/openai/whisper-large-v3-turbo").strip()

# Optional Gladia STT (async pre-recorded API: upload → create job → poll). By default Gladia is a
# FAILOVER used only after Groq (an A/B test on this drive's content showed Gladia mis-detects the
# language and hallucinates in a random language more often than Groq's whisper-large-v3, and its
# utterances carry no Whisper stats so `_is_confident_segment` can't filter them). Set
# GLADIA_PRIMARY=1 to try it FIRST instead. Either way it falls back on ANY error OR once Gladia's
# free monthly quota (10 h) is exhausted. Empty key = Gladia disabled (Groq-only).
GLADIA_API_KEY = os.environ.get("GLADIA_API_KEY", "").strip()
GLADIA_PRIMARY = os.environ.get("GLADIA_PRIMARY", "0") not in ("0", "false", "False", "")
GLADIA_BASE_URL = os.environ.get("GLADIA_BASE_URL", "https://api.gladia.io/v2").rstrip("/")
GLADIA_POLL_INTERVAL_S = float(os.environ.get("GLADIA_POLL_INTERVAL_S", "4"))
GLADIA_MAX_WAIT_S = float(os.environ.get("GLADIA_MAX_WAIT_S", "600"))


def _cloudflare_stt_enabled() -> bool:
    return bool(CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN)


def _gladia_stt_enabled() -> bool:
    return bool(GLADIA_API_KEY)


def stt_available() -> bool:
    """True if any STT provider is configured (Gladia, Groq keys, or the Cloudflare failover)."""
    return _gladia_stt_enabled() or bool(GROQ_API_KEYS) or _cloudflare_stt_enabled()

# Target languages every video should end up with (besides the original).
SUBTITLE_TARGET_LANGS = [l.strip() for l in os.environ.get(
    "SUBTITLE_TARGET_LANGS", "en,id").split(",") if l.strip()]
# Split audio into chunks of this many seconds to stay under Groq's per-file size cap
# and to spread requests across keys. Each chunk is offset by index * CHUNK_SECONDS.
SUBTITLE_CHUNK_SECONDS = int(os.environ.get("SUBTITLE_CHUNK_SECONDS", "600"))
# Transcribe this many chunks CONCURRENTLY (each on a different rotating API key). Defaults to
# the number of keys so a long video's chunks fan out across all free-tier keys at once instead
# of one-at-a-time — finishing far faster and usually within the single download window (so the
# expensive re-download-to-repair path is rarely needed). Capped at the key count to avoid
# hammering one key with several parallel requests.
SUBTITLE_CHUNK_CONCURRENCY = int(os.environ.get("SUBTITLE_CHUNK_CONCURRENCY", "0"))  # 0 = auto
# In-job retry: while the video is still on disk, a chunk that hits a transient Groq error is
# retried a few times (after a short back-off) BEFORE being left for the slow repair pass. This
# absorbs brief Groq blips without re-downloading the whole video.
SUBTITLE_CHUNK_RETRY_ATTEMPTS = int(os.environ.get("SUBTITLE_CHUNK_RETRY_ATTEMPTS", "3"))
SUBTITLE_CHUNK_RETRY_DELAY_S = int(os.environ.get("SUBTITLE_CHUNK_RETRY_DELAY_S", "20"))
# Translation retry: the free Google endpoint occasionally returns the input unchanged (a
# soft-throttle no-op) when hit in rapid bursts. Retry a failed/no-op track a few times with a
# short back-off before giving up, so a transient throttle doesn't permanently drop a language.
SUBTITLE_TRANSLATE_RETRY = int(os.environ.get("SUBTITLE_TRANSLATE_RETRY", "3"))
SUBTITLE_TRANSLATE_RETRY_DELAY_S = int(os.environ.get("SUBTITLE_TRANSLATE_RETRY_DELAY_S", "4"))
# Translation-repair: how many backfill-start passes may attempt a still-incomplete part before
# we stop retrying its missing target languages (keeps a permanently-untranslatable part from
# being reprocessed every restart forever).
SUBTITLE_TL_REPAIR_MAX = int(os.environ.get("SUBTITLE_TL_REPAIR_MAX", "5"))
# Skip videos shorter/smaller than this (audio extraction still cheap, but avoids noise).
SUBTITLE_MIN_BYTES = int(os.environ.get("SUBTITLE_MIN_MB", "1")) * 1048576

# --- Hallucination / low-confidence filtering (faster-whisper's default thresholds) ---
# Whisper reliably HALLUCINATES plausible boilerplate ("subscribe", "thanks for watching", …) —
# often in a RANDOM language — on music/silence/non-speech audio. Those segments carry tell-tale
# stats in verbose_json: a high no_speech_prob, a low avg_logprob, or a high gzip compression_ratio
# (from looping). We drop them so a music-only video no longer produces a bogus random-language track.
SUBTITLE_NO_SPEECH_MAX = float(os.environ.get("SUBTITLE_NO_SPEECH_MAX", "0.6"))
SUBTITLE_LOGPROB_MIN = float(os.environ.get("SUBTITLE_LOGPROB_MIN", "-1.0"))
SUBTITLE_COMPRESSION_MAX = float(os.environ.get("SUBTITLE_COMPRESSION_MAX", "2.4"))

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


def _parse_ts(s: str) -> float:
    """Parse a WebVTT/SRT timestamp (HH:MM:SS.mmm or MM:SS.mmm) → seconds."""
    s = s.strip().replace(",", ".")
    parts = s.split(":")
    try:
        if len(parts) == 3:
            h, m, rest = parts
        elif len(parts) == 2:
            h, (m, rest) = "0", parts
        else:
            return 0.0
        sec, _, ms = rest.partition(".")
        return int(h) * 3600 + int(m) * 60 + int(sec) + int((ms or "0").ljust(3, "0")[:3]) / 1000.0
    except Exception:  # noqa: BLE001
        return 0.0


def _parse_vtt(path: Path) -> list[dict]:
    """Read a WebVTT file back into [{start, end, text}] (inverse of _build_vtt)."""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:  # noqa: BLE001
        return []
    segs: list[dict] = []
    for block in re.split(r"\n\s*\n", text):
        lines = [l for l in block.splitlines() if l.strip()]
        ts_idx = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if ts_idx is None:
            continue
        m = re.search(r"(\d{1,2}:\d{2}(?::\d{2})?[.,]\d+)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d+)",
                      lines[ts_idx])
        if not m:
            continue
        body = " ".join(lines[ts_idx + 1:]).strip()
        if body:
            segs.append({"start": _parse_ts(m.group(1)), "end": _parse_ts(m.group(2)), "text": body})
    return segs


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


def _key_order(start: int | None = None) -> list[str]:
    """Return the keys starting at an offset so load is spread across calls/chunks.

    `start=None` uses a rotating global counter (sequential callers); pass an explicit offset
    (e.g. the chunk index) so concurrent chunks each begin on a different key.
    """
    global _key_index
    if not GROQ_API_KEYS:
        return []
    if start is None:
        start = _key_index
        _key_index += 1
    start %= len(GROQ_API_KEYS)
    return GROQ_API_KEYS[start:] + GROQ_API_KEYS[:start]


async def _transcribe_chunk_groq(client: httpx.AsyncClient, audio_path: Path, key_offset: int | None = None) -> dict:
    """POST one audio chunk to Groq, rotating keys on 429 and models on exhaustion.

    `key_offset` (the chunk index, when called concurrently) picks the starting key so parallel
    chunks spread across the free-tier keys instead of all starting on the same one.
    """
    last_err: Exception | None = None
    for model in GROQ_STT_MODELS:
        for key in _key_order(key_offset):
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
                log.info("Groq STT ok: %s via key …%s model %s", audio_path.name, key[-4:], model)
                return resp.json()
            except httpx.HTTPError as e:
                last_err = e
                log.warning("Groq request error on key …%s model %s: %s", key[-4:], model, e)
                await asyncio.sleep(1)
                continue
    raise last_err or RuntimeError("All Groq keys/models failed")


async def _transcribe_chunk_cloudflare(client: httpx.AsyncClient, audio_path: Path) -> dict:
    """Transcribe one chunk via Cloudflare Workers AI Whisper, normalised to Groq's verbose_json
    shape ({"language", "segments":[{start,end,text}], "text"}) so the merge code is provider-agnostic."""
    import base64
    audio_b64 = base64.b64encode(audio_path.read_bytes()).decode("ascii")
    url = f"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/{CLOUDFLARE_STT_MODEL}"
    resp = await client.post(
        url,
        headers={"Authorization": f"Bearer {CLOUDFLARE_API_TOKEN}"},
        json={"audio": audio_b64},
    )
    resp.raise_for_status()
    payload = resp.json()
    if not payload.get("success", True):
        raise RuntimeError(f"Cloudflare AI error: {payload.get('errors')}")
    result = payload.get("result") or {}
    segments = []
    for s in result.get("segments") or []:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        segments.append({"start": float(s.get("start", 0.0) or 0.0),
                         "end": float(s.get("end", 0.0) or 0.0), "text": text})
    info = result.get("transcription_info") or {}
    language = info.get("language") or result.get("language") or "xx"
    return {"language": language, "segments": segments, "text": result.get("text", "")}


async def _transcribe_chunk_gladia(client: httpx.AsyncClient, audio_path: Path) -> dict:
    """Transcribe one chunk via Gladia's async pre-recorded API (upload → create job → poll),
    normalised to the internal verbose_json shape ({"language", "segments":[{start,end,text}], "text"})
    so the merge code stays provider-agnostic.

    Raises on any HTTP error (incl. quota-exhausted create calls) and on a poll timeout, so the
    caller (`_transcribe_chunk`) can fall back to Groq. Gladia utterances carry no Whisper stats
    (no_speech_prob/avg_logprob/…), so `_is_confident_segment` keeps them as-is — fine, because
    Gladia's own VAD already suppresses the music/silence hallucinations that filter targets."""
    headers = {"x-gladia-key": GLADIA_API_KEY}
    # 1. Upload the audio chunk → audio_url
    with open(audio_path, "rb") as fh:
        files = {"audio": (audio_path.name, fh, "audio/flac")}
        up = await client.post(f"{GLADIA_BASE_URL}/upload", headers=headers, files=files)
    up.raise_for_status()
    audio_url = up.json().get("audio_url")
    if not audio_url:
        raise RuntimeError("Gladia upload returned no audio_url")
    # 2. Create the transcription job (a 4xx here — e.g. quota exhausted — falls back to Groq)
    job = await client.post(f"{GLADIA_BASE_URL}/pre-recorded", headers=headers,
                            json={"audio_url": audio_url})
    job.raise_for_status()
    result_url = job.json().get("result_url")
    if not result_url:
        raise RuntimeError("Gladia job returned no result_url")
    # 3. Poll the result_url until status is done/error (bounded by GLADIA_MAX_WAIT_S)
    import time as _time
    deadline = _time.monotonic() + GLADIA_MAX_WAIT_S
    payload: dict = {}
    while True:
        r = await client.get(result_url, headers=headers)
        r.raise_for_status()
        payload = r.json()
        status = payload.get("status")
        if status == "done":
            break
        if status == "error":
            raise RuntimeError(f"Gladia transcription error: {payload.get('error') or payload}")
        if _time.monotonic() > deadline:
            raise TimeoutError(f"Gladia transcription timed out after {GLADIA_MAX_WAIT_S:.0f}s")
        await asyncio.sleep(GLADIA_POLL_INTERVAL_S)
    transcription = (payload.get("result") or {}).get("transcription") or {}
    segments = []
    for u in transcription.get("utterances") or []:
        text = (u.get("text") or "").strip()
        if not text:
            continue
        segments.append({"start": float(u.get("start", 0.0) or 0.0),
                         "end": float(u.get("end", 0.0) or 0.0), "text": text})
    langs = transcription.get("languages") or []
    language = langs[0] if langs else "xx"
    return {"language": language, "segments": segments, "text": transcription.get("full_transcript", "")}


async def _transcribe_chunk(client: httpx.AsyncClient, audio_path: Path, key_offset: int | None = None) -> dict:
    """Transcribe one chunk. Provider order: Gladia (primary, when configured) → Groq (key+model
    failover, the free-tier volume workhorse) → Cloudflare Workers AI. Each stage falls through to
    the next on ANY error (Gladia quota-exhausted, Groq 429s exhausted, …) so a single job never
    dies on one provider being down or capped."""
    # Gladia first when it's the configured primary (quality + strong VAD).
    if _gladia_stt_enabled() and GLADIA_PRIMARY:
        try:
            result = await _transcribe_chunk_gladia(client, audio_path)
            log.info("Gladia STT ok: %s (%d utterances)", audio_path.name, len(result.get("segments") or []))
            return result
        except Exception as gladia_err:  # noqa: BLE001
            log.warning("Gladia STT failed for %s (%s) — falling back to Groq", audio_path.name, gladia_err)
    try:
        return await _transcribe_chunk_groq(client, audio_path, key_offset)
    except Exception as groq_err:  # noqa: BLE001
        # If Gladia is configured but NOT the primary, try it here as a failover before Cloudflare.
        if _gladia_stt_enabled() and not GLADIA_PRIMARY:
            try:
                result = await _transcribe_chunk_gladia(client, audio_path)
                log.info("Gladia STT ok: %s (Groq failover)", audio_path.name)
                return result
            except Exception as gladia_err:  # noqa: BLE001
                log.warning("Gladia STT failover failed for %s: %s", audio_path.name, gladia_err)
        if _cloudflare_stt_enabled():
            try:
                result = await _transcribe_chunk_cloudflare(client, audio_path)
                log.info("Cloudflare STT ok: %s via %s (Groq failover)", audio_path.name, CLOUDFLARE_STT_MODEL)
                return result
            except Exception as cf_err:  # noqa: BLE001
                log.warning("Cloudflare STT failover failed for %s: %s", audio_path.name, cf_err)
        raise groq_err


# ---------------------------------------------------------------------------
# Segment hygiene: drop hallucinated / low-confidence output
# ---------------------------------------------------------------------------
def _is_confident_segment(seg: dict) -> bool:
    """True if a verbose_json segment looks like real speech (not a music/silence hallucination).
    Segments missing the stats (e.g. the Cloudflare failover) are kept as-is."""
    no_speech = seg.get("no_speech_prob")
    avg_lp = seg.get("avg_logprob")
    comp = seg.get("compression_ratio")
    # Whisper itself flags no speech AND is unsure about what it heard → silence misfire.
    if (isinstance(no_speech, (int, float)) and isinstance(avg_lp, (int, float))
            and no_speech > SUBTITLE_NO_SPEECH_MAX and avg_lp < SUBTITLE_LOGPROB_MIN):
        return False
    # Degenerate, highly compressible output → a looping/repeating hallucination.
    if isinstance(comp, (int, float)) and comp > SUBTITLE_COMPRESSION_MAX:
        return False
    # Very low average log-prob → unreliable transcription regardless of no_speech_prob.
    if isinstance(avg_lp, (int, float)) and avg_lp < SUBTITLE_LOGPROB_MIN - 0.5:
        return False
    return True


def _collapse_consecutive_dupes(segs: list[dict]) -> list[dict]:
    """Merge runs of identical back-to-back lines (a Whisper looping hallucination) into one,
    extending the kept segment's end so playback timing is preserved."""
    out: list[dict] = []
    for s in segs:
        if out and out[-1]["text"].strip().lower() == s["text"].strip().lower():
            out[-1]["end"] = max(out[-1]["end"], s["end"])
            continue
        out.append(dict(s))
    return out


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
        state = {"lang": cache.get("lang", "xx")}        # updated under `lock` by concurrent chunks

        nkeys = len(GROQ_API_KEYS) or 1
        concurrency = SUBTITLE_CHUNK_CONCURRENCY if SUBTITLE_CHUNK_CONCURRENCY > 0 else nkeys
        concurrency = max(1, min(concurrency, nkeys, total))
        sem = asyncio.Semaphore(concurrency)
        lock = asyncio.Lock()

        async def transcribe_one(client: httpx.AsyncClient, idx: int, chunk: Path) -> None:
            if str(idx) in cached:
                return  # already transcribed in an earlier attempt — keep it
            result = None
            last: Exception | None = None
            for attempt in range(1, SUBTITLE_CHUNK_RETRY_ATTEMPTS + 1):
                async with sem:  # bound concurrent Groq requests to the key count
                    try:
                        result = await _transcribe_chunk(client, chunk, key_offset=idx)
                        break
                    except Exception as e:  # noqa: BLE001
                        last = e
                # back off OUTSIDE the semaphore so a sleeping retry frees its slot for others
                if attempt < SUBTITLE_CHUNK_RETRY_ATTEMPTS:
                    log.warning("Subtitle: part %d chunk %d attempt %d/%d failed (%s) — retry in %ds",
                                part_id, idx, attempt, SUBTITLE_CHUNK_RETRY_ATTEMPTS, last,
                                SUBTITLE_CHUNK_RETRY_DELAY_S)
                    await asyncio.sleep(SUBTITLE_CHUNK_RETRY_DELAY_S)
            if result is None:
                log.warning("Subtitle: part %d chunk %d still failing after %d attempts (%s) "
                            "— leaving for repair", part_id, idx, SUBTITLE_CHUNK_RETRY_ATTEMPTS, last)
                return  # missing slot; a later pass retries just this chunk
            segs = []
            for seg in result.get("segments", []) or []:
                text = (seg.get("text") or "").strip()
                if not text or not _is_confident_segment(seg):
                    continue
                segs.append({
                    "start": float(seg.get("start", 0.0)),
                    "end": float(seg.get("end", 0.0)),
                    "text": text,
                })
            segs = _collapse_consecutive_dupes(segs)
            async with lock:
                # Only a chunk that yielded real, confident speech may set the source language — a
                # hallucinated music/silence chunk (now filtered to empty) must not label the whole
                # video with a random language (the bug behind "subtitles in a random language").
                if segs and state["lang"] == "xx":
                    state["lang"] = _iso_from_groq_language(result.get("language"))
                cached[str(idx)] = segs
                # Persist after every chunk so progress survives a crash/restart mid-video.
                _save_chunks_cache(part_id, {"lang": state["lang"], "chunks": cached})

        timeout = httpx.Timeout(180.0, connect=30.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            await asyncio.gather(*(transcribe_one(client, idx, chunk)
                                   for idx, chunk in enumerate(chunks)))
        source_lang = state["lang"]

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
# Translation (deep-translator → Google free endpoint, with a Groq-LLM failover), timestamps preserved
# ---------------------------------------------------------------------------
# Map our ISO source codes to the ones deep-translator's GoogleTranslator expects. It has no bare
# "zh" — Chinese must be zh-CN/zh-TW. Anything not listed is passed through unchanged.
_TRANSLATOR_SRC = {"zh": "zh-CN"}


# ISO code → English language name, for prompting the Groq LLM translator (inverse of the STT map,
# plus the codes deep-translator/Whisper hand us that aren't keyed there).
_ISO_TO_LANG_NAME = {v: k.capitalize() for k, v in _LANG_NAME_TO_ISO.items()}
_ISO_TO_LANG_NAME.update({"en": "English", "id": "Indonesian", "zh": "Chinese", "ja": "Japanese",
                          "ko": "Korean", "ms": "Malay"})


def _groq_translate_batch(texts: list[str], target: str, source: str | None) -> list[str | None]:
    """Translate a batch of subtitle lines via a Groq chat model — the reliable failover for when
    the free Google endpoint throttles/echoes. Returns a same-length list (None where a line still
    couldn't be translated) so alignment is preserved and validation can drop the gaps. Runs sync
    (called from `_translate_segments`, itself already off the event loop via asyncio.to_thread)."""
    if not (GROQ_TRANSLATE and GROQ_API_KEYS and texts):
        return [None] * len(texts)
    tgt = _ISO_TO_LANG_NAME.get(target, target)
    src = _ISO_TO_LANG_NAME.get(source or "", None)
    src_clause = f"from {src} " if src else ""
    system = (
        f"You are a professional subtitle translator. Translate each input line {src_clause}"
        f"into {tgt}. The input has exactly {len(texts)} lines separated by newlines. Output "
        f"EXACTLY {len(texts)} lines — one translation per input line, in the same order. Output "
        f"ONLY the translated lines: no numbering, no commentary, no blank lines between them. "
        f"If a line is untranslatable, output its best transliteration rather than dropping it.")
    user = "\n".join(texts)
    for key in _key_order():
        try:
            with httpx.Client(timeout=120) as c:
                resp = c.post(
                    GROQ_CHAT_URL,
                    headers={"Authorization": f"Bearer {key}"},
                    json={"model": GROQ_TRANSLATE_MODEL, "temperature": 0,
                          "messages": [{"role": "system", "content": system},
                                       {"role": "user", "content": user}]},
                )
            if resp.status_code == 429:
                continue  # rate-limited on this key → try the next
            resp.raise_for_status()
            content = (resp.json()["choices"][0]["message"]["content"] or "").strip("\n")
            lines = content.split("\n")
            while lines and lines[-1].strip() == "":  # trim trailing formatting blanks only
                lines.pop()
            if len(lines) == len(texts):
                log.info("Groq LLM translated %d lines → %s (Google failover)", len(texts), target)
                return [(l.strip() or None) for l in lines]
            log.warning("Groq translate to %s line-count mismatch (%d vs %d) — unusable",
                        target, len(lines), len(texts))
            return [None] * len(texts)
        except Exception as e:  # noqa: BLE001
            log.warning("Groq translate to %s failed on key …%s: %s", target, key[-4:], e)
            continue
    return [None] * len(texts)


# Latin-script target languages: a correct translation into these is (near) all Latin letters. A
# line that comes back dominated by another script (Hangul, CJK, Thai, Arabic, Cyrillic, …) is the
# translator echoing the source or drifting into a random language — the "subtitles in a random
# language" symptom. We route such lines to the Groq failover and, if still wrong, drop them.
_LATIN_TARGETS = {"en", "id", "ms", "es", "fr", "de", "pt", "it", "nl", "tr", "tl", "vi", "pl", "ro"}


def _is_latin_letter(c: str) -> bool:
    if not c.isalpha():
        return False
    o = ord(c)
    return (0x41 <= o <= 0x5A or 0x61 <= o <= 0x7A       # A–Z a–z
            or 0x00C0 <= o <= 0x024F                       # Latin-1 supplement + Extended-A/B
            or 0x1E00 <= o <= 0x1EFF)                      # Latin Extended Additional


def _bad_target_script(text: str, target: str) -> bool:
    """True if `text` is likely NOT in `target` (only checked for Latin-script targets): more than
    ~30% of its letters are non-Latin, i.e. the translator echoed the source / returned another
    language. Punctuation/number-only lines are never flagged."""
    if target not in _LATIN_TARGETS or not text:
        return False
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return False
    non_latin = sum(1 for c in letters if not _is_latin_letter(c))
    return non_latin / len(letters) > 0.30


def _make_translator(target: str, source: str | None):
    """Build a GoogleTranslator using the KNOWN source language when we have it. Auto-detect is a
    trap here: Google silently echoes the input (no translation) for some content — e.g.
    Traditional Chinese → English — so a wrong/auto source quietly drops the whole track. We pass
    the real source (mapped to a valid code) and only fall back to auto if that code is rejected.
    """
    from deep_translator import GoogleTranslator
    if source and source not in ("xx", "orig", "auto"):
        code = _TRANSLATOR_SRC.get(source, source)
        try:
            return GoogleTranslator(source=code, target=target)
        except Exception:  # noqa: BLE001 — unsupported code → fall back to auto-detect
            pass
    return GoogleTranslator(source="auto", target=target)


def _translate_segments(segments: list[dict], target: str, source: str | None = None) -> list[dict] | None:
    """Translate segment texts to `target`, keeping timestamps. Runs in a thread (blocking lib).

    Returns None when the result isn't a usable translation (library missing, or essentially no
    segment actually translated). Crucially it NEVER passes the original-language text through as
    a "translation": a segment that fails to translate is DROPPED, not emitted verbatim — so we
    can't end up with an EN/ID track that secretly contains the original language. The `source`
    language is used (not auto-detect) because auto silently no-ops on some content — see
    `_make_translator`.
    """
    if not segments:
        return None
    import time
    try:
        translator = _make_translator(target, source)
    except Exception as e:  # noqa: BLE001
        log.warning("deep-translator not available (%s) — skipping %s track", e, target)
        return None

    SEP = "\n"
    CHAR_BUDGET = 3500

    def _google_batch(texts: list[str]) -> list[str | None]:
        """Translate a batch via Google → same-length list; a failed item is None (never the original)."""
        if not texts:
            return []
        joined = SEP.join(texts)
        for attempt in range(5):
            try:
                res = translator.translate(joined)
                if res:
                    parts = [p.strip() for p in res.split(SEP)]
                    if len(parts) == len(texts):
                        return parts
                    log.warning("Batch translate to %s size mismatch (expected %d, got %d) - attempt %d/5",
                                target, len(texts), len(parts), attempt + 1)
                    time.sleep(2)
            except Exception as e:  # noqa: BLE001
                log.warning("Batch translate to %s failed (%s) - attempt %d/5", target, e, attempt + 1)
                time.sleep(2)

        # Fallback to per-item with rate limit prevention
        log.warning("Batch translate to %s failed all attempts — falling back to per-item", target)
        out: list[str | None] = []
        for t in texts:
            if not t or t in (".", "Oh", "M"):
                out.append(t)
                continue
            for _ in range(3):
                try:
                    out.append(translator.translate(t) or None)
                    break
                except Exception:  # noqa: BLE001
                    time.sleep(1)
            else:
                out.append(None)
            time.sleep(0.5)
        return out

    def translate_batch(texts: list[str]) -> list[str | None]:
        """Translate a batch → same-length list. Google first; any line Google couldn't translate
        (None) is retried via the Groq LLM failover so a throttled/echoing Google no longer drops
        whole tracks. A failed item stays None (never the original text)."""
        res = _google_batch(texts)
        # A slot is "missing" if Google failed (None) OR returned a wrong-script echo (e.g. Korean
        # text in an EN track) — both get re-translated by the reliable Groq LLM.
        missing = [i for i, v in enumerate(res)
                   if not v or not str(v).strip() or _bad_target_script(str(v), target)]
        if missing:
            filled = _groq_translate_batch([texts[i] for i in missing], target, source)
            for i, val in zip(missing, filled):
                # Accept the Groq result only if it's a real, right-script translation; otherwise
                # drop the slot (None) so a wrong-language caption is never shown.
                res[i] = val if (val and val.strip() and not _bad_target_script(val, target)) else None
        return res

    translated: list[dict] = []
    ok = 0          # segments that produced a real translation
    unchanged = 0   # of those, how many came back identical to the source text

    def flush(group: list[dict]) -> None:
        nonlocal ok, unchanged
        if not group:
            return
        for b, nt in zip(group, translate_batch([g["text"] for g in group])):
            if not nt or not nt.strip():
                continue  # drop a failed segment — do NOT emit original-language text
            # Drop any segment that came back in the wrong script (source/other language leaking
            # through into a Latin-script target — Korean, Chinese, Thai, Cyrillic, …).
            if _bad_target_script(nt, target):
                continue
            ok += 1
            if nt.strip() == b["text"].strip():
                unchanged += 1
            translated.append({"start": b["start"], "end": b["end"], "text": nt})

    batch: list[dict] = []
    batch_len = 0
    for seg in segments:
        t = seg["text"]
        if batch and batch_len + len(t) > CHAR_BUDGET:
            flush(batch)
            batch, batch_len = [], 0
        batch.append(seg)
        batch_len += len(t) + 1
    flush(batch)

    if ok == 0:
        return None  # nothing translated → caller leaves the track absent

    leaks = sum(1 for b in translated if _bad_target_script(b["text"], target))
    if ok > 1 and (unchanged >= ok or leaks > ok * 0.1):
        log.warning("Translate to %s failed validation (unchanged=%d, leaks=%d out of %d) — treating as failed",
                    target, unchanged, leaks, ok)
        return None
    return translated


async def _translate_track(segments: list[dict], target: str, source: str | None = None) -> list[dict] | None:
    """Translate a track to `target`, retrying on failure/no-op (the free Google endpoint
    sometimes echoes the input unchanged under rapid bursts). Returns None only after all
    SUBTITLE_TRANSLATE_RETRY attempts fail, so a transient throttle never silently drops a lang."""
    for attempt in range(1, SUBTITLE_TRANSLATE_RETRY + 1):
        try:
            result = await asyncio.to_thread(_translate_segments, segments, target, source)
        except Exception as e:  # noqa: BLE001
            log.warning("Translate to %s attempt %d errored (%s)", target, attempt, e)
            result = None
        if result:
            return result
        if attempt < SUBTITLE_TRANSLATE_RETRY:
            await asyncio.sleep(SUBTITLE_TRANSLATE_RETRY_DELAY_S)
    return None


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------
async def _record_subtitle(db, part_id: int, lang: str) -> None:
    if db is None:
        return
    try:
        await db.execute(
            "INSERT INTO subtitles (part_id, lang, created_at) VALUES (?, ?, now_text()) "
            "ON CONFLICT(part_id, lang) DO UPDATE SET created_at=now_text()",
            [part_id, lang],
        )
    except Exception as e:  # noqa: BLE001
        log.warning("Could not record subtitle row part %d/%s: %s", part_id, lang, e)


# ---------------------------------------------------------------------------
# Translation repair (download-free): fix videos whose translations failed under the old
# logic, straight from the on-disk original VTT — no video re-download, no Groq STT.
# Fixes both "only the original track exists" and "EN/ID exist but contain the original text".
# ---------------------------------------------------------------------------
# Bump when the repair LOGIC changes so every part is re-examined once under the new rules. v2
# re-translates every target from the known source (v1 used Google auto-detect, which silently
# echoed some content — e.g. Traditional Chinese — leaving target tracks partly untranslated). v3
# adds Groq-LLM failover + target-script validation: any en/id segment that came back in the wrong
# script (Korean/CJK/Thai/… leaking through) is re-translated by Groq or dropped, fixing the
# "subtitles in a random language" tracks across the whole drive — download-free, from disk.
_TL_REPAIR_VERSION = "3"


def _tl_repair_marker(part_id: int) -> Path:
    """Records translation-repair progress as `<version>|<state>`. State holds `ok`/`noop` once
    finalised, else an attempt count so a still-incomplete part is retried (≤ SUBTITLE_TL_REPAIR_MAX).
    A marker from an older version is reprocessed (re-translated) under the current rules."""
    return SUBTITLES_DIR / f"part_{part_id}.tlok"


def _tl_repair_state(part_id: int) -> tuple[str | None, str | int] | None:
    """None = never attempted; else (version, state) where state is "ok"/"noop"/int(attempts).
    A legacy marker (no version, e.g. old "done"/"ok") returns version None → eligible to reprocess."""
    p = _tl_repair_marker(part_id)
    if not p.exists():
        return None
    try:
        txt = p.read_text(encoding="utf-8").strip()
    except Exception:  # noqa: BLE001
        return (None, 0)
    ver, sep, rest = txt.partition("|")
    if not sep:  # legacy unversioned marker → force reprocess under the current version
        return (None, 0)
    rest = rest.strip()
    state: str | int = rest if rest in ("ok", "noop") else (int(rest) if rest.isdigit() else 0)
    return (ver, state)


def _write_tl_marker(part_id: int, state: str | int) -> None:
    try:
        _tl_repair_marker(part_id).write_text(f"{_TL_REPAIR_VERSION}|{state}", encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def _expected_targets(src_lang: str) -> list[str]:
    return [t for t in SUBTITLE_TARGET_LANGS if t != src_lang]


def _part_ids_with_vtt() -> list[int]:
    if not SUBTITLES_DIR.exists():
        return []
    ids = set()
    for f in SUBTITLES_DIR.glob("part_*.*.vtt"):
        m = re.match(r"part_(\d+)\.", f.name)
        if m:
            ids.add(int(m.group(1)))
    return sorted(ids)


async def _repair_one_translation(db, part_id: int) -> None:
    langs = set(available_langs(part_id))
    if not langs:
        _write_tl_marker(part_id, "noop")
        return

    # Under a NEW repair version, re-translate every target once (overwriting a track that an
    # older version mistranslated/echoed); within the same version we only fill genuine gaps.
    st = _tl_repair_state(part_id)
    old_version = st[0] if st else None
    attempts = st[1] if (st and isinstance(st[1], int)) else 0
    force = old_version != _TL_REPAIR_VERSION
    if force:
        attempts = 0

    # 1. Work out the source language + which VTT holds the ORIGINAL-language text.
    src_lang = _load_chunks_cache(part_id).get("lang", "xx")
    if src_lang in ("xx", ""):
        non_target = [l for l in sorted(langs) if l not in SUBTITLE_TARGET_LANGS and l != "orig"]
        src_lang = non_target[0] if non_target else ("orig" if "orig" in langs else "xx")

    orig_file: Path | None = None
    hidden = False  # original text leaked into the target files (symptom b, no real orig track)
    if src_lang not in ("xx", "") and subtitle_path(part_id, src_lang).exists():
        orig_file = subtitle_path(part_id, src_lang)
    else:
        # No standalone original track. If two+ target tracks are byte-identical they actually
        # hold the original-language text → recover from one of them.
        present = [t for t in SUBTITLE_TARGET_LANGS if subtitle_path(part_id, t).exists()]
        if len(present) >= 2:
            contents = {subtitle_path(part_id, t).read_text(encoding="utf-8") for t in present}
            if len(contents) == 1:
                orig_file, hidden = subtitle_path(part_id, present[0]), True
                if src_lang in ("xx", ""):
                    src_lang = "orig"

    if orig_file is None:
        _write_tl_marker(part_id, "noop")  # looks genuinely fine
        return

    segments = _parse_vtt(orig_file)
    if not segments:
        _write_tl_marker(part_id, "noop")
        return

    # If the original was hiding inside the target files, write the real original track now.
    if hidden and src_lang not in ("xx", ""):
        subtitle_path(part_id, src_lang).write_text(_build_vtt(segments), encoding="utf-8")
        await _record_subtitle(db, part_id, src_lang)

    orig_text = orig_file.read_text(encoding="utf-8")
    repaired: list[str] = []
    for target in _expected_targets(src_lang):
        tpath = subtitle_path(part_id, target)
        # On a version bump (`force`) re-translate every target — an older version may have
        # written a track that's partly the original language. Otherwise only fill genuine gaps:
        # a missing track, or one whose content is still the original text (symptom b).
        if not force and not hidden and tpath.exists() and tpath.read_text(encoding="utf-8") != orig_text:
            continue  # already a genuine, different translation — leave it
        translated = await _translate_track(segments, target, src_lang)  # known source + retries
        if translated:
            tpath.write_text(_build_vtt(translated), encoding="utf-8")
            await _record_subtitle(db, part_id, target)
            repaired.append(target)

    if repaired:
        log.info("Translation repair: part %d re-translated %s from %s (on-disk, no download)",
                 part_id, ", ".join(repaired), src_lang)

    # Finalise based on COMPLETENESS, not just "attempted": if a target is still missing (e.g. a
    # persistent Google throttle), bump the attempt count so a later pass retries it — until the
    # budget runs out — instead of marking it done and dropping the language forever.
    missing = [t for t in _expected_targets(src_lang) if not subtitle_path(part_id, t).exists()]
    if not missing or attempts + 1 >= SUBTITLE_TL_REPAIR_MAX:
        # A part with an original track but no done/partial marker and no chunk cache came from a
        # fully-transcribed run that only failed at translation → it's complete now, finalise it.
        if (not _done_marker(part_id).exists() and not _partial_marker(part_id).exists()
                and not _chunks_cache_path(part_id).exists()):
            _done_marker(part_id).write_text("ok", encoding="utf-8")
        _write_tl_marker(part_id, "ok" if not missing else attempts + 1)
        if missing:
            log.warning("Translation repair: part %d giving up on %s after %d attempts",
                        part_id, ", ".join(missing), attempts + 1)
    else:
        _write_tl_marker(part_id, attempts + 1)
        log.info("Translation repair: part %d still missing %s — will retry next pass (attempt %d/%d)",
                 part_id, ", ".join(missing), attempts + 1, SUBTITLE_TL_REPAIR_MAX)


async def repair_translations_on_disk(db) -> None:
    """Download-free repair of any part whose translations failed under the old logic. Runs from
    the persistent /subtitles volume, so it costs nothing but a few Google translate calls. A part
    is skipped once finalised (`ok`/`noop`); an incomplete one is retried on later passes until its
    target languages are all present or the attempt budget (SUBTITLE_TL_REPAIR_MAX) runs out."""
    if not (SUBTITLE_GEN and SUBTITLES_DIR.exists()):
        return
    for part_id in _part_ids_with_vtt():
        st = _tl_repair_state(part_id)
        if st is not None and st[0] == _TL_REPAIR_VERSION:
            ver, state = st
            # Finalised under the CURRENT version, or out of retries → skip. An older version is
            # always reprocessed (re-translated under the new rules).
            if state in ("ok", "noop") or (isinstance(state, int) and state >= SUBTITLE_TL_REPAIR_MAX):
                continue
        try:
            await _repair_one_translation(db, part_id)
        except Exception:  # noqa: BLE001
            # Leave the marker as-is so a transient failure is retried on the next pass.
            log.exception("Translation repair failed for part %d", part_id)


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
            if not stt_available():
                log.warning("Subtitle: no STT provider configured (Groq/Cloudflare) — skipping part %d", part_id)
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
                # Best-effort (with retry): a translation failure must never abort finalisation
                # (else a fully-transcribed video would be re-downloaded every restart just to
                # retry the translation). Worst case the part keeps only its original track.
                translated = await _translate_track(segments, target, source_lang)
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
