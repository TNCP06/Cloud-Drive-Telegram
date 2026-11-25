"""Unit tests for bot/stream_subtitles.py translation, failover, completeness & repair."""

import asyncio
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))

# Stub capcut_subtitles if playwright isn't installed in unit-test env
if "capcut_subtitles" not in sys.modules:
    cap = types.ModuleType("capcut_subtitles")
    cap.CAPCUT_LANG = "Indonesian"
    cap.CAPCUT_PRIMARY = True
    cap.CAPCUT_TIMEOUT_S = 180
    cap.capcut_available = lambda: False
    cap.capcut_lang_iso = lambda x: "orig"
    cap.resolve_capcut_language = lambda x: None
    cap.transcribe_with_capcut = AsyncMock(return_value=[])
    sys.modules["capcut_subtitles"] = cap

import stream_subtitles as ss  # noqa: E402


def _make_vtt(count: int, prefix: str = "こんにちは") -> str:
    segs = [{"start": float(i * 2), "end": float(i * 2 + 1.5), "text": f"{prefix} {i}"} for i in range(count)]
    return ss._build_vtt(segs)


class SubtitleTranslationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="tcd_subtest_"))
        self.orig_dir = ss.SUBTITLES_DIR
        ss.SUBTITLES_DIR = self.tmp

    def tearDown(self):
        ss.SUBTITLES_DIR = self.orig_dir
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_parse_reset_delay(self):
        import httpx
        self.assertEqual(ss._parse_reset_delay(httpx.Headers({"x-ratelimit-reset-tokens": "7.282s"})), 7.282)
        self.assertEqual(ss._parse_reset_delay(httpx.Headers({"x-ratelimit-reset-tokens": "500ms"})), 1.0)
        self.assertEqual(ss._parse_reset_delay(httpx.Headers({"retry-after": "25"})), 15.0)
        self.assertEqual(ss._parse_reset_delay(httpx.Headers({})), 6.0)

    def test_groq_429_waits_and_recovers(self):
        orig_keys = ss.GROQ_API_KEYS
        ss.GROQ_API_KEYS = ["gsk_test_key_1234"]
        try:
            call_count = 0

            def fake_post(*args, **kwargs):
                nonlocal call_count
                call_count += 1
                resp = MagicMock()
                if call_count == 1:
                    resp.status_code = 429
                    resp.headers = ss.httpx.Headers({"x-ratelimit-reset-tokens": "1.5s"})
                    return resp
                resp.status_code = 200
                resp.headers = ss.httpx.Headers({})
                resp.json.return_value = {"choices": [{"message": {"content": "Halo\nDunia"}}]}
                resp.raise_for_status = lambda: None
                return resp

            with patch.object(ss.httpx.Client, "post", side_effect=fake_post), patch("time.sleep") as mock_sleep:
                out = ss._groq_translate_subbatch(["こんにちは", "世界"], "id", "ja")

            self.assertEqual(out, ["Halo", "Dunia"])
            self.assertEqual(call_count, 2)
            mock_sleep.assert_called_once()
        finally:
            ss.GROQ_API_KEYS = orig_keys

    def test_rejects_severely_truncated_translation(self):
        segs = [{"start": float(i), "end": float(i + 0.5), "text": f"Line {i}"} for i in range(20)]

        # Simulate only 4/20 cues translating (20% < 75%)
        def partial_gtx(texts, target, source):
            return [f"Terjemahan {i}" if i < 4 else None for i in range(len(texts))]

        with (
            patch.object(ss, "GEMINI_API_KEYS", []),
            patch.object(ss, "GROQ_API_KEYS", []),
            patch.object(ss, "CLOUDFLARE_ACCOUNT_ID", ""),
            patch.object(ss, "_google_gtx_batch", side_effect=partial_gtx),
        ):
            result = ss._translate_segments(segs, "id", "ja")
        self.assertIsNone(result)

    def test_cf_and_gtx_failover_fill_missing_lines(self):
        segs = [{"start": float(i), "end": float(i + 0.5), "text": f"テスト {i}"} for i in range(10)]

        with (
            patch.object(ss, "GEMINI_API_KEYS", []),
            patch.object(ss, "GROQ_API_KEYS", ["gsk_1234"]),
            patch.object(ss, "_groq_translate_batch", return_value=["Test 0", "Test 1"] + [None] * 8),
            patch.object(ss, "CLOUDFLARE_ACCOUNT_ID", "acc"),
            patch.object(ss, "CLOUDFLARE_API_TOKEN", "tok"),
            patch.object(ss, "_cf_translate_batch", return_value=["Test 2", "Test 3", "Test 4"] + [None] * 5),
            patch.object(ss, "_google_gtx_batch", return_value=["Test 5", "Test 6", "Test 7", "Test 8", "Test 9"]),
        ):
            result = ss._translate_segments(segs, "en", "ja")
        self.assertIsNotNone(result)
        self.assertEqual(len(result), 10)

    def test_repair_upgrades_truncated_without_downgrade_and_skips_healthy(self):
        async def run():
            db = MagicMock()
            db.execute = AsyncMock()

            # Part 2016: ja=40, en=36 (already >=75%), id=5 (truncated 12.5%!)
            ss.subtitle_path(2016, "ja").write_text(_make_vtt(40, "日本語"), encoding="utf-8")
            ss.subtitle_path(2016, "en").write_text(_make_vtt(36, "English line"), encoding="utf-8")
            ss.subtitle_path(2016, "id").write_text(_make_vtt(5, "Baris indo"), encoding="utf-8")
            # Legacy v3 marker had falsely locked this broken track as ok
            (self.tmp / "part_2016.tlok").write_text("3|ok", encoding="utf-8")

            called_targets = []

            async def fake_translate(segments, target, source=None):
                called_targets.append((target, source))
                return [{"start": s["start"], "end": s["end"], "text": f"{target} {i}"} for i, s in enumerate(segments)]

            with (
                patch.object(ss, "_translate_track", side_effect=fake_translate),
                patch.object(ss, "backup_subtitle_to_telegram", new=AsyncMock(return_value=9991)),
            ):
                await ss.repair_translations_on_disk(db)

            # en was already healthy (36/40 = 90%), only id should be repaired!
            self.assertEqual(called_targets, [("id", "ja")])
            self.assertEqual(len(ss._parse_vtt(ss.subtitle_path(2016, "id"))), 40)
            self.assertEqual((self.tmp / "part_2016.tlok").read_text(encoding="utf-8"), f"{ss._TL_REPAIR_VERSION}|ok")

            # Part 1171: English-only source must translate to id (no longer noop)
            ss.subtitle_path(1171, "en").write_text(_make_vtt(10, "Hello world"), encoding="utf-8")
            (self.tmp / "part_1171.tlok").write_text("3|noop", encoding="utf-8")
            called_targets.clear()
            with (
                patch.object(ss, "_translate_track", side_effect=fake_translate),
                patch.object(ss, "backup_subtitle_to_telegram", new=AsyncMock(return_value=9992)),
            ):
                await ss.repair_translations_on_disk(db)

            self.assertEqual(called_targets, [("id", "en")])
            self.assertEqual(len(ss._parse_vtt(ss.subtitle_path(1171, "id"))), 10)

            # Non-destructive guard: never overwrite 36 cues with 32 cues
            ss.subtitle_path(2099, "ja").write_text(_make_vtt(40, "日本語"), encoding="utf-8")
            ss.subtitle_path(2099, "en").write_text(_make_vtt(25, "Eng"), encoding="utf-8")  # <75%, triggers repair

            async def smaller_translate(segments, target, source=None):
                # Suppose target is en and returns 20 cues, id returns 40
                n = 20 if target == "en" else len(segments)
                return [{"start": s["start"], "end": s["end"], "text": f"{target} {i}"} for i, s in enumerate(segments[:n])]

            with (
                patch.object(ss, "_translate_track", side_effect=smaller_translate),
                patch.object(ss, "backup_subtitle_to_telegram", new=AsyncMock(return_value=9993)),
            ):
                await ss._repair_one_translation(db, 2099)

            self.assertEqual(len(ss._parse_vtt(ss.subtitle_path(2099, "en"))), 25)
            self.assertEqual(len(ss._parse_vtt(ss.subtitle_path(2099, "id"))), 40)

        asyncio.run(run())

    def test_worker_writes_tlok_when_all_targets_complete(self):
        async def run():
            ss.init_subtitle_semaphore()
            video = self.tmp / "sample.mp4"
            video.write_bytes(b"0" * 1024)
            db = MagicMock()
            db.execute = AsyncMock()

            segs = [{"start": float(i), "end": float(i + 1), "text": f"セリフ {i}"} for i in range(10)]
            repair_called = False

            async def track_repair(*args, **kwargs):
                nonlocal repair_called
                repair_called = True

            with (
                patch.object(ss, "SUBTITLE_MIN_BYTES", 10),
                patch.object(ss, "CAPCUT_PRIMARY", False),
                patch.object(ss, "ENABLE_WHISPER_FULL_STT", True),
                patch.object(ss, "stt_available", return_value=True),
                patch.object(ss, "probe_audio_language", new=AsyncMock(return_value=("ja", "Japanese"))),
                patch.object(ss, "_transcribe_audio", new=AsyncMock(return_value=(segs, "ja", 0, 1))),
                patch.object(ss, "_translate_track", new=AsyncMock(
                    side_effect=lambda s, tgt, src=None: [
                        {"start": x["start"], "end": x["end"], "text": f"{tgt} {i}"} for i, x in enumerate(s)
                    ]
                )),
                patch.object(ss, "backup_subtitle_to_telegram", new=AsyncMock(return_value=1234)),
            ):
                await ss.run_subtitle_job(db, 3001, str(video))

            self.assertEqual((self.tmp / "part_3001.tlok").read_text(encoding="utf-8"), f"{ss._TL_REPAIR_VERSION}|ok")
            with patch.object(ss, "_repair_one_translation", side_effect=track_repair):
                await ss.repair_translations_on_disk(db)
            self.assertFalse(repair_called)

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
